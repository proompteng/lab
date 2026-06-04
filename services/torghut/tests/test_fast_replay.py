from __future__ import annotations

import ast
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery import fast_replay
from app.trading.discovery.candidate_specs import (
    CANDIDATE_SPEC_SCHEMA_VERSION,
    CandidateSpec,
)
from app.trading.discovery.fast_replay import (
    FAST_REPLAY_PROOF_SEMANTICS_LABEL,
    build_fast_replay_preview,
)
from app.trading.discovery.replay_tape import (
    build_source_query_digest,
    load_replay_tape,
    materialize_signal_tape,
)
from app.trading.models import SignalEnvelope


class TestFastReplayPreview(TestCase):
    def _spec(
        self,
        candidate_spec_id: str,
        *,
        symbols: list[str],
        selection_mode: str = "continuation",
        max_notional_per_trade: str = "2500",
    ) -> CandidateSpec:
        return CandidateSpec(
            schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
            candidate_spec_id=candidate_spec_id,
            hypothesis_id=f"hyp-{candidate_spec_id}",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="sleeve",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={"mechanism": "test hpairs", "required_features": ["ofi"]},
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": max_notional_per_trade,
                "params": {
                    "selection_mode": selection_mode,
                    "signal_motif": "ofi_lob_response_continuation",
                    "rank_feature": "cross_section_session_open_rank",
                },
                "universe_symbols": symbols,
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={"promotion_policy": "research_only"},
        )

    def _signal(
        self,
        *,
        symbol: str,
        offset: int,
        price: str,
        ofi: str,
        volume: str = "100000",
        stress: bool = False,
        event_type: str = "trade",
        queue_ratio: str = "0.15",
        feed_delay_ms: str = "40",
    ) -> SignalEnvelope:
        mid = Decimal(price)
        fill_qty = Decimal("100") if event_type == "trade" else Decimal("0")
        order_type = "market" if event_type == "trade" else "limit"
        fill_status = "filled" if fill_qty > 0 else "unfilled"
        return SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
            + timedelta(minutes=offset),
            symbol=symbol,
            timeframe="1Min",
            seq=offset,
            source="test",
            payload={
                "price": mid,
                "bid": mid - Decimal("0.01"),
                "ask": mid + Decimal("0.01"),
                "spread_bps": Decimal("2"),
                "ofi": Decimal(ofi),
                "order_book_imbalance": Decimal(ofi),
                "microbar_volume": Decimal(volume),
                "event_type": event_type,
                "order_type": order_type,
                "fill_status": fill_status,
                "order_qty": Decimal("100"),
                "queue_ratio": Decimal(queue_ratio),
                "fill_qty": fill_qty,
                "feed_delay_ms": Decimal(feed_delay_ms),
                "feed_trade_direction": "buy",
                "authoritative_trade_direction": "buy",
                "trade_direction": "buy",
                "trade_size": Decimal("100"),
                "round_trip_latency_ms": Decimal("2.0"),
                "odd_lot_bid_size": Decimal("20"),
                "odd_lot_ask_size": Decimal("18"),
                "off_exchange_trade": stress,
                "algo_activity_score": Decimal("0.80") if stress else Decimal("0.20"),
                "model_inference_latency_ms": Decimal("120")
                if stress
                else Decimal("5"),
                "bid_size": Decimal("700"),
                "ask_size": Decimal("300"),
                "macro_event_window": stress,
                "net_dealer_gamma_exposure": Decimal("-9000000")
                if stress
                else Decimal("5000000"),
                "zero_dte_option_volume": Decimal("80000")
                if stress
                else Decimal("1000"),
                "weekly_option_availability": stress,
                "option_days_to_expiry": Decimal("0") if stress else Decimal("21"),
                "jump_bps": Decimal("120") if stress else Decimal("2"),
                "news_event_window": stress,
                "session_open_window": stress,
                "forecast_return_bps": Decimal("1.0") if stress else Decimal("12.0"),
                "transaction_cost_bps": Decimal("4.0"),
                "cost_filtered_action": "buy",
                "walk_forward_fold_id": f"wf-{offset}",
                "multi_scale_trend_score": Decimal("0.60")
                if stress
                else Decimal("0.85"),
                "dynamic_variable_weights": {
                    "ofi": "0.35",
                    "spread": "0.20",
                    "volume": "0.15",
                },
            },
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )

    def test_whitepaper_features_rank_and_label_preview_only(self) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=1, price="100", ofi="0.65", event_type="add"
                ),
                self._signal(
                    symbol="AAA", offset=2, price="101", ofi="0.80", event_type="trade"
                ),
                self._signal(
                    symbol="AAA", offset=3, price="102", ofi="0.85", event_type="cancel"
                ),
                self._signal(
                    symbol="BBB", offset=1, price="100", ofi="-0.10", stress=True
                ),
                self._signal(
                    symbol="BBB", offset=2, price="99", ofi="-0.20", stress=True
                ),
                self._signal(
                    symbol="BBB", offset=3, price="98", ofi="-0.20", stress=True
                ),
            ]
            source_query_digest = build_source_query_digest({"window": "fast"})
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-fast",
                symbols=("AAA", "BBB"),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=source_query_digest,
                source_table_versions={"signals": "v1"},
                feature_schema_hash="feature-fast",
                cost_model_hash="cost-fast",
                strategy_family="hpairs-fast",
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec("spec-good", symbols=["AAA"]),
                self._spec("spec-stress", symbols=["BBB"], selection_mode="reversal"),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=2,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        self.assertEqual(
            preview.selected_candidate_spec_ids, ("spec-good", "spec-stress")
        )
        good, stress = preview.rows
        self.assertEqual(good.candidate_spec_id, "spec-good")
        self.assertGreater(good.cluster_lob_activity_score, Decimal("0"))
        self.assertGreater(good.ofi_decay_alignment_score, Decimal("0"))
        self.assertEqual(good.frontier_bucket, "exploitation")
        self.assertEqual(stress.frontier_bucket, "exploration")
        self.assertGreater(stress.macro_stress_veto_score, Decimal("0"))
        payload = preview.to_manifest_payload()
        row_payload = good.to_payload()
        stress_payload = stress.to_payload()
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])
        self.assertFalse(row_payload["final_authority_ok"])
        self.assertEqual(
            payload["proof_semantics_label"], FAST_REPLAY_PROOF_SEMANTICS_LABEL
        )
        self.assertIn(
            "source_backed_runtime_ledger_proof_required", payload["blockers"]
        )
        self.assertIn("conformal_tail_risk", payload["implemented_mechanisms"])
        self.assertIn(
            "hawkes_event_time_excitation_replay_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "mpc_market_limit_execution_schedule_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "order_book_observability_feedback_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "markov_order_transition_latent_regime_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "order_flow_entropy_hmm_regime_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "dynamic_lead_lag_cross_asset_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "queue_position_survival_fill_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "public_feed_lag_quoted_liquidity_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "lob_simulation_reality_gap_execution_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "alpha_decay_predictability_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "counterfactual_regime_replay_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "nonlinear_impact_execution_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "option_gamma_flow_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "intraday_jump_burst_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "intraday_price_path_asymmetry_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "rough_flow_volatility_impact_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "institutional_mechanism_fidelity_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "signal_adaptive_execution_resilience_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "microstructure_regime_tokenization_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "cost_aware_forecast_filter_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "adaptive_market_limit_allocation_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "metaorder_adverse_selection_stress",
            payload["implemented_mechanisms"],
        )
        self.assertIn(
            "bootstrap_robust_optimization_stress",
            payload["implemented_mechanisms"],
        )
        self.assertEqual(
            row_payload["target_implied_notional_context"]["target_net_pnl_per_day"],
            "500",
        )
        self.assertIn("observed_post_cost_expectancy_bps", row_payload)
        self.assertIn("execution_schedule_stress", row_payload)
        self.assertFalse(row_payload["execution_schedule_stress"]["proof_authority"])
        self.assertFalse(
            row_payload["execution_schedule_stress"]["promotion_authority"]
        )
        self.assertIn("order_book_observability_stress", row_payload)
        self.assertFalse(
            row_payload["order_book_observability_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["order_book_observability_stress"]["promotion_authority"]
        )
        self.assertIn(
            "arxiv-2605.19584",
            {
                source["source_id"]
                for source in row_payload["order_book_observability_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn("order_transition_stress", row_payload)
        self.assertFalse(row_payload["order_transition_stress"]["proof_authority"])
        self.assertFalse(row_payload["order_transition_stress"]["promotion_authority"])
        self.assertEqual(
            row_payload["order_transition_stress"]["status"],
            "preview_only_order_transition_stress_ranking",
        )
        self.assertIn(
            "arxiv-2502.07625",
            {
                source["source_id"]
                for source in row_payload["order_transition_stress"]["source_papers"]
            },
        )
        self.assertIn("order_flow_entropy_regime_stress", row_payload)
        self.assertFalse(
            row_payload["order_flow_entropy_regime_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["order_flow_entropy_regime_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["order_flow_entropy_regime_stress"]["status"],
            "preview_only_order_flow_entropy_regime_stress_ranking",
        )
        self.assertIn(
            "ssrn-5315733",
            {
                source["source_id"]
                for source in row_payload["order_flow_entropy_regime_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn("lead_lag_cross_asset_stress", row_payload)
        self.assertFalse(row_payload["lead_lag_cross_asset_stress"]["proof_authority"])
        self.assertFalse(
            row_payload["lead_lag_cross_asset_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["lead_lag_cross_asset_stress"]["status"],
            "preview_only_lead_lag_cross_asset_stress_ranking",
        )
        self.assertIn(
            "arxiv-2511.00390",
            {
                source["source_id"]
                for source in row_payload["lead_lag_cross_asset_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn(
            "lead_lag_cross_asset_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "lead_lag_cross_asset_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("queue_survival_fill_stress", row_payload)
        self.assertFalse(row_payload["queue_survival_fill_stress"]["proof_authority"])
        self.assertFalse(
            row_payload["queue_survival_fill_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["queue_survival_fill_stress"]["status"],
            "preview_only_queue_survival_fill_stress_ranking",
        )
        self.assertIn(
            "arxiv-2512.05734",
            {
                source["source_id"]
                for source in row_payload["queue_survival_fill_stress"]["source_papers"]
            },
        )
        self.assertIn("feed_lag_liquidity_stress", row_payload)
        self.assertFalse(row_payload["feed_lag_liquidity_stress"]["proof_authority"])
        self.assertFalse(
            row_payload["feed_lag_liquidity_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["feed_lag_liquidity_stress"]["status"],
            "preview_only_feed_lag_liquidity_stress_ranking",
        )
        self.assertIn(
            "ssrn-6675338",
            {
                source["source_id"]
                for source in row_payload["feed_lag_liquidity_stress"]["source_papers"]
            },
        )
        self.assertIn("lob_reality_gap_stress", row_payload)
        self.assertFalse(row_payload["lob_reality_gap_stress"]["proof_authority"])
        self.assertFalse(row_payload["lob_reality_gap_stress"]["promotion_authority"])
        self.assertEqual(
            row_payload["lob_reality_gap_stress"]["status"],
            "preview_only_lob_reality_gap_stress_ranking",
        )
        self.assertIn(
            "arxiv-2603.24137",
            {
                source["source_id"]
                for source in row_payload["lob_reality_gap_stress"]["source_papers"]
            },
        )
        self.assertIn(
            "arxiv-2502.07071",
            {
                source["source_id"]
                for source in row_payload["lob_reality_gap_stress"]["source_papers"]
            },
        )
        self.assertTrue(
            row_payload["lob_reality_gap_stress"][
                "responsive_exchange_simulation_preview"
            ]
        )
        self.assertIn("alpha_decay_predictability_stress", row_payload)
        self.assertFalse(
            row_payload["alpha_decay_predictability_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["alpha_decay_predictability_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["alpha_decay_predictability_stress"]["status"],
            "preview_only_alpha_decay_predictability_ranking",
        )
        self.assertIn(
            "arxiv-2601.02310",
            {
                source["source_id"]
                for source in row_payload["alpha_decay_predictability_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn("counterfactual_regime_replay_stress", row_payload)
        self.assertFalse(
            row_payload["counterfactual_regime_replay_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["counterfactual_regime_replay_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["counterfactual_regime_replay_stress"]["status"],
            "preview_only_counterfactual_regime_replay_stress_ranking",
        )
        self.assertIn(
            "arxiv-2602.03776",
            {
                source["source_id"]
                for source in row_payload["counterfactual_regime_replay_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn("nonlinear_impact_execution_stress", row_payload)
        self.assertFalse(
            row_payload["nonlinear_impact_execution_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["nonlinear_impact_execution_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["nonlinear_impact_execution_stress"]["status"],
            "preview_only_nonlinear_impact_execution_stress_ranking",
        )
        self.assertIn(
            "arxiv-2603.29086",
            {
                source["source_id"]
                for source in row_payload["nonlinear_impact_execution_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn("option_gamma_flow_stress", row_payload)
        self.assertFalse(row_payload["option_gamma_flow_stress"]["proof_authority"])
        self.assertFalse(row_payload["option_gamma_flow_stress"]["promotion_authority"])
        self.assertEqual(
            row_payload["option_gamma_flow_stress"]["status"],
            "preview_only_option_gamma_flow_stress_ranking",
        )
        self.assertIn(
            "ssrn-4692190",
            {
                source["source_id"]
                for source in row_payload["option_gamma_flow_stress"]["source_papers"]
            },
        )
        self.assertIn(
            "option_gamma_flow_stress_penalty_active", row_payload["risk_flags"]
        )
        self.assertIn(
            "option_gamma_flow_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("intraday_jump_burst_stress", row_payload)
        self.assertFalse(row_payload["intraday_jump_burst_stress"]["proof_authority"])
        self.assertFalse(
            row_payload["intraday_jump_burst_stress"]["promotion_authority"]
        )
        self.assertEqual(
            row_payload["intraday_jump_burst_stress"]["status"],
            "preview_only_intraday_jump_burst_stress_ranking",
        )
        self.assertIn(
            "ssrn-5223127",
            {
                source["source_id"]
                for source in row_payload["intraday_jump_burst_stress"]["source_papers"]
            },
        )
        self.assertIn("rough_flow_volatility_stress", row_payload)
        self.assertEqual(
            row_payload["rough_flow_volatility_stress"]["status"],
            "preview_only_rough_flow_volatility_stress_ranking",
        )
        self.assertIn(
            "arxiv-2601.23172",
            {
                source["source_id"]
                for source in row_payload["rough_flow_volatility_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(row_payload["rough_flow_volatility_stress"]["proof_authority"])
        self.assertFalse(
            row_payload["rough_flow_volatility_stress"]["promotion_authority"]
        )
        self.assertIn("institutional_mechanism_fidelity_stress", row_payload)
        self.assertEqual(
            row_payload["institutional_mechanism_fidelity_stress"]["status"],
            "preview_only_institutional_mechanism_fidelity_stress_ranking",
        )
        self.assertIn(
            "arxiv-2604.18046",
            {
                source["source_id"]
                for source in row_payload["institutional_mechanism_fidelity_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(
            row_payload["institutional_mechanism_fidelity_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["institutional_mechanism_fidelity_stress"][
                "promotion_authority"
            ]
        )
        self.assertIn(
            "institutional_mechanism_fidelity_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "institutional_mechanism_fidelity_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("signal_adaptive_execution_resilience_stress", row_payload)
        self.assertEqual(
            row_payload["signal_adaptive_execution_resilience_stress"]["status"],
            "preview_only_signal_adaptive_execution_resilience_stress_ranking",
        )
        self.assertIn(
            "arxiv-2605.24242",
            {
                source["source_id"]
                for source in row_payload[
                    "signal_adaptive_execution_resilience_stress"
                ]["source_papers"]
            },
        )
        self.assertFalse(
            row_payload["signal_adaptive_execution_resilience_stress"][
                "proof_authority"
            ]
        )
        self.assertFalse(
            row_payload["signal_adaptive_execution_resilience_stress"][
                "promotion_authority"
            ]
        )
        self.assertIn(
            "signal_adaptive_execution_resilience_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "signal_adaptive_execution_resilience_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("microstructure_regime_tokenization_stress", row_payload)
        self.assertEqual(
            row_payload["microstructure_regime_tokenization_stress"]["status"],
            "preview_only_microstructure_regime_tokenization_stress_ranking",
        )
        self.assertIn(
            "arxiv-2604.20949",
            {
                source["source_id"]
                for source in row_payload["microstructure_regime_tokenization_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn(
            "arxiv-2602.23784",
            {
                source["source_id"]
                for source in row_payload["microstructure_regime_tokenization_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(
            row_payload["microstructure_regime_tokenization_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["microstructure_regime_tokenization_stress"][
                "promotion_authority"
            ]
        )
        self.assertIn(
            "microstructure_regime_tokenization_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "microstructure_regime_tokenization_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("cost_aware_forecast_filter_stress", row_payload)
        self.assertEqual(
            row_payload["cost_aware_forecast_filter_stress"]["status"],
            "preview_only_cost_aware_forecast_filter_stress_ranking",
        )
        self.assertIn(
            "arxiv-2606.00060",
            {
                source["source_id"]
                for source in row_payload["cost_aware_forecast_filter_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn(
            "arxiv-2512.12727",
            {
                source["source_id"]
                for source in row_payload["cost_aware_forecast_filter_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(
            row_payload["cost_aware_forecast_filter_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["cost_aware_forecast_filter_stress"]["promotion_authority"]
        )
        self.assertIn(
            "cost_aware_forecast_filter_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "cost_aware_forecast_filter_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("adaptive_market_limit_allocation_stress", row_payload)
        self.assertEqual(
            row_payload["adaptive_market_limit_allocation_stress"]["status"],
            "preview_only_adaptive_market_limit_allocation_stress_ranking",
        )
        self.assertIn(
            "arxiv-2507.06345",
            {
                source["source_id"]
                for source in row_payload["adaptive_market_limit_allocation_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn(
            "arxiv-2603.29086",
            {
                source["source_id"]
                for source in row_payload["adaptive_market_limit_allocation_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(
            row_payload["adaptive_market_limit_allocation_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["adaptive_market_limit_allocation_stress"][
                "promotion_authority"
            ]
        )
        self.assertIn(
            "adaptive_market_limit_allocation_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "adaptive_market_limit_allocation_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("metaorder_adverse_selection_stress", row_payload)
        self.assertEqual(
            row_payload["metaorder_adverse_selection_stress"]["status"],
            "preview_only_metaorder_adverse_selection_stress_ranking",
        )
        self.assertIn(
            "arxiv-2510.27334",
            {
                source["source_id"]
                for source in row_payload["metaorder_adverse_selection_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertIn(
            "doi-10.1007/s10203-026-00570-z",
            {
                source["source_id"]
                for source in row_payload["metaorder_adverse_selection_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(
            row_payload["metaorder_adverse_selection_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["metaorder_adverse_selection_stress"]["promotion_authority"]
        )
        self.assertIn(
            "metaorder_adverse_selection_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "metaorder_adverse_selection_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("bootstrap_robust_optimization_stress", row_payload)
        self.assertEqual(
            row_payload["bootstrap_robust_optimization_stress"]["status"],
            "preview_only_bootstrap_robust_optimization_stress_ranking",
        )
        self.assertIn(
            "arxiv-2510.12725",
            {
                source["source_id"]
                for source in row_payload["bootstrap_robust_optimization_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(
            row_payload["bootstrap_robust_optimization_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["bootstrap_robust_optimization_stress"]["promotion_authority"]
        )
        self.assertIn(
            "bootstrap_robust_optimization_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "bootstrap_robust_optimization_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn(
            "intraday_jump_burst_stress_penalty_active",
            stress_payload["risk_flags"],
        )
        self.assertIn(
            "intraday_jump_burst_stress_downranks_only",
            stress_payload["ranking_only_reasons"],
        )
        self.assertIn("intraday_price_path_asymmetry_stress", row_payload)
        self.assertEqual(
            row_payload["intraday_price_path_asymmetry_stress"]["status"],
            "preview_only_intraday_price_path_asymmetry_stress_ranking",
        )
        self.assertIn(
            "ssrn-6074846",
            {
                source["source_id"]
                for source in row_payload["intraday_price_path_asymmetry_stress"][
                    "source_papers"
                ]
            },
        )
        self.assertFalse(
            row_payload["intraday_price_path_asymmetry_stress"]["proof_authority"]
        )
        self.assertFalse(
            row_payload["intraday_price_path_asymmetry_stress"]["promotion_authority"]
        )
        self.assertIn(
            "intraday_price_path_asymmetry_stress_penalty_active",
            row_payload["risk_flags"],
        )
        self.assertIn(
            "intraday_price_path_asymmetry_stress_downranks_only",
            row_payload["ranking_only_reasons"],
        )
        self.assertIn("cost_impact_lineage", row_payload)
        self.assertIn("impact_capacity_lineage", row_payload)
        self.assertEqual(
            row_payload["cost_impact_lineage"]["impact_model"],
            "square_root_power_law_capacity_proxy",
        )
        self.assertEqual(
            row_payload["impact_capacity_lineage"]["model"],
            "square_root_power_law_impact_proxy",
        )
        self.assertIn("hpairs_macro_window_stress", row_payload)
        self.assertFalse(row_payload["hpairs_macro_window_stress"]["proof_authority"])
        self.assertIn("hpairs_clusterlob_order_flow_feature_lane", row_payload)
        feature_lane = row_payload["hpairs_clusterlob_order_flow_feature_lane"]
        self.assertEqual(feature_lane["status"], "preview_only_research_ranking")
        self.assertEqual(
            feature_lane["resource_scope"],
            "local_offline_replay_tape_or_fixture_rows_only",
        )
        self.assertFalse(feature_lane["promotion_allowed"])
        self.assertFalse(feature_lane["promotion_authority"])
        self.assertFalse(feature_lane["final_authority_ok"])
        self.assertIn("feature_schema_hashes", feature_lane)
        self.assertIn(
            "hpairs_clusterlob_order_flow_feature_lane",
            payload,
        )
        manifest_lane = payload["hpairs_clusterlob_order_flow_feature_lane"]
        self.assertEqual(manifest_lane["status"], "preview_only_research_ranking")
        self.assertFalse(manifest_lane["promotion_allowed"])
        self.assertFalse(manifest_lane["final_authority_ok"])
        self.assertEqual(
            row_payload["adv_capacity_context"]["status"], "missing_source_backed_adv"
        )
        self.assertIn("source_backed_adv_missing", row_payload["lineage_blockers"])
        self.assertFalse(row_payload["promotion_proof"])
        self.assertFalse(row_payload["proof_authority"])
        self.assertIn("risk_flags", row_payload)
        self.assertIn("source_backed_adv_missing", row_payload["risk_flags"])
        self.assertEqual(
            payload["replay_tape"]["dataset_snapshot_ref"], "snapshot-fast"
        )
        self.assertEqual(
            payload["replay_tape"]["source_query_digest"], source_query_digest
        )
        self.assertEqual(
            payload["replay_tape"]["source_table_versions"], {"signals": "v1"}
        )
        self.assertIn("feature_schema_hash", payload["replay_tape"])
        self.assertIn("cost_model_hash", payload["replay_tape"])
        self.assertIn("strategy_family", payload["replay_tape"])
        self.assertEqual(payload["replay_tape"]["cache_identity"]["status"], "complete")
        self.assertEqual(payload["replay_tape"]["feature_schema_hash"], "feature-fast")
        self.assertEqual(payload["replay_tape"]["cost_model_hash"], "cost-fast")
        self.assertEqual(payload["replay_tape"]["strategy_family"], "hpairs-fast")
        self.assertFalse(payload["proof_authority"])
        self.assertEqual(
            row_payload["candidate_lineage"]["hypothesis_id"], "hyp-spec-good"
        )
        self.assertEqual(
            row_payload["candidate_lineage"]["family_template_id"],
            "microbar_cross_sectional_pairs_v1",
        )
        self.assertTrue(row_payload["candidate_lineage"]["lineage_preserved"])
        self.assertFalse(row_payload["candidate_lineage"]["final_authority_ok"])
        self.assertEqual(
            row_payload["frontier_selection"]["reason_code"],
            "fast_replay_frontier_exploitation_selected",
        )
        self.assertEqual(
            row_payload["discovery_stage_metadata"]["preview_status"],
            "preview_only_ranked",
        )
        self.assertTrue(
            row_payload["discovery_stage_metadata"]["exact_replay_qualified"]
        )
        self.assertEqual(
            row_payload["discovery_stage_metadata"]["evidence_collection_status"],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertFalse(row_payload["discovery_stage_metadata"]["promotion_allowed"])
        self.assertFalse(
            row_payload["frontier_selection"]["discovery_stage_metadata"][
                "final_promotion_allowed"
            ]
        )
        self.assertFalse(row_payload["frontier_selection"]["promotion_allowed"])
        self.assertEqual(
            payload["discovery_stage_semantics"]["authority"],
            "candidate_discovery_only",
        )
        self.assertFalse(
            payload["discovery_stage_semantics"][
                "exact_replay_frontier_can_authorize_promotion"
            ]
        )
        sim_queue = payload["bounded_sim_target_queue"]
        self.assertEqual(sim_queue["status"], "metadata_only_not_dispatched")
        self.assertEqual(
            sim_queue["discovery_stage_semantics"]["preview_only_status"],
            "preview_only_ranked",
        )
        self.assertEqual(
            sim_queue["selected_candidate_spec_ids"], ["spec-good", "spec-stress"]
        )
        self.assertFalse(sim_queue["kubernetes_fanout_allowed"])
        self.assertFalse(sim_queue["db_writes_allowed"])
        self.assertFalse(sim_queue["proof_packet_upload_allowed"])
        self.assertFalse(sim_queue["final_authority_ok"])

    def test_loaded_hpairs_replay_tape_features_feed_offline_ranking_only(
        self,
    ) -> None:
        def hpairs_signal(offset: int, price: str, ofi: str) -> SignalEnvelope:
            return SignalEnvelope(
                event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
                + timedelta(minutes=offset),
                symbol="AAA",
                timeframe="1Min",
                seq=offset,
                source="test",
                payload={
                    "price": Decimal(price),
                    "spread_bps": Decimal("2"),
                    "microbar_volume": Decimal("100000"),
                    "ofi_horizons": {
                        "3": Decimal(ofi),
                        "12": Decimal("0.25"),
                    },
                    "ofi_decay_memory": {
                        "half_life_3": Decimal("0.60"),
                        "half_life_12": Decimal("0.30"),
                    },
                    "cluster_lob_bucket": "directional",
                    "regime_tags": ["opening_drive"],
                    "target_implied_notional": Decimal("50000"),
                },
                ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
            )

        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            materialize_signal_tape(
                rows=[
                    hpairs_signal(1, "100", "0.70"),
                    hpairs_signal(2, "101", "0.80"),
                    hpairs_signal(3, "102", "0.90"),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-hpairs-features",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest(
                    {"window": "hpairs-features"}
                ),
                feature_schema_hash="feature-hpairs",
                cost_model_hash="cost-hpairs",
                strategy_family="hpairs-feature-ranking",
            )
            tape = load_replay_tape(tape_path)

        preview = build_fast_replay_preview(
            specs=(self._spec("spec-hpairs", symbols=["AAA"]),),
            rows=tape.rows,
            replay_tape_manifest=tape.manifest,
            top_k=1,
            min_rows_per_candidate=2,
        )

        row = preview.rows[0]
        payload = row.to_payload()
        self.assertGreater(row.ofi_pressure_score, Decimal("0"))
        self.assertGreater(row.ofi_decay_alignment_score, Decimal("0"))
        self.assertEqual(row.frontier_bucket, "exploitation")
        self.assertIn("hpairs_replay_tape_features", tape.rows[0].payload)
        self.assertFalse(
            tape.rows[0].payload["hpairs_replay_tape_features"]["proof_authority"]
        )
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_ofi_pressure_uses_nonstandard_hpair_horizon_values(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
            symbol="AAA",
            timeframe="1Min",
            seq=1,
            source="test",
            payload={
                "hpairs_replay_tape_features": {
                    "order_flow_imbalance_horizons": {
                        "custom_short": "125",
                        "custom_long": "175",
                        "bad": "not-a-decimal",
                    },
                },
            },
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )

        ofi_pressure = fast_replay._extract_ofi_pressure(signal)

        self.assertIsNotNone(ofi_pressure)
        assert ofi_pressure is not None
        self.assertGreater(ofi_pressure, 0.9)
        self.assertLessEqual(ofi_pressure, 1.0)

    def test_ofi_pressure_uses_replay_tape_memory_regime_slices(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
            symbol="AAA",
            timeframe="1Min",
            seq=1,
            source="test",
            payload={
                "hpairs_replay_tape_features": {
                    "ofi_memory_regime_slices": {
                        "horizons": {
                            "instant": "0.30",
                            "short": "0.50",
                            "medium": "0.20",
                            "long": "0.10",
                        },
                        "directional_alignment_score": "0.35",
                        "regime_bucket": "positive_ofi_shock",
                        "prefilter_only": True,
                        "proof_authority": False,
                    },
                    "cluster_lob": {"bucket": "aggressive_buy_pressure"},
                },
            },
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )

        ofi_pressure = fast_replay._extract_ofi_pressure(signal)
        ofi_memory = fast_replay._extract_ofi_memory_regime_score(signal)

        self.assertEqual(ofi_pressure, 0.275)
        self.assertEqual(ofi_memory, 0.35)

    def test_target_implied_notional_blocks_non_positive_expectancy(self) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(symbol="AAA", offset=1, price="100", ofi="0.50"),
                self._signal(symbol="AAA", offset=2, price="102", ofi="0.50"),
                self._signal(symbol="BBB", offset=1, price="102", ofi="0.50"),
                self._signal(symbol="BBB", offset=2, price="100", ofi="0.50"),
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-notional",
                symbols=("AAA", "BBB"),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "notional"}),
                feature_schema_hash="feature-notional",
                cost_model_hash="cost-notional",
                strategy_family="hpairs-notional",
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec(
                    "spec-positive",
                    symbols=["AAA"],
                    max_notional_per_trade="0",
                ),
                self._spec(
                    "spec-negative",
                    symbols=["BBB"],
                    max_notional_per_trade="0",
                ),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=2,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        payloads = {row.candidate_spec_id: row.to_payload() for row in preview.rows}
        positive = payloads["spec-positive"]
        positive_expectancy = Decimal(positive["observed_post_cost_expectancy_bps"])
        self.assertGreater(positive_expectancy, Decimal("0"))
        self.assertEqual(
            Decimal(positive["required_daily_notional"]),
            Decimal("500") / (positive_expectancy / Decimal("10000")),
        )
        self.assertFalse(positive["target_implied_notional_context"]["blocked"])
        self.assertEqual(
            positive["target_implied_notional_context"]["formula"],
            "target_net_pnl_per_day/(observed_post_cost_expectancy_bps/10000)",
        )

        negative = payloads["spec-negative"]
        self.assertLessEqual(
            Decimal(negative["observed_post_cost_expectancy_bps"]), Decimal("0")
        )
        self.assertIsNone(negative["required_daily_notional"])
        self.assertTrue(negative["target_implied_notional_context"]["blocked"])
        self.assertEqual(
            negative["target_implied_notional_context"]["feasibility_status"],
            "blocked_non_positive_post_cost_expectancy",
        )
        self.assertIn(
            "target_implied_notional_blocked_non_positive_expectancy",
            negative["lineage_blockers"],
        )
        self.assertIn(
            "positive_post_cost_expectancy_missing",
            negative["lineage_blockers"],
        )

    def test_fast_preview_ranking_uses_combined_preview_score_before_raw_prefilter(
        self,
    ) -> None:
        def row(
            candidate_spec_id: str,
            *,
            preview_score: str,
            prefilter_score: str,
            exploration_score: str = "0",
            is_hpairs_candidate: bool = True,
        ) -> fast_replay.FastReplayPreviewRow:
            return fast_replay.FastReplayPreviewRow(
                candidate_spec_id=candidate_spec_id,
                rank=0,
                preview_score=Decimal(preview_score),
                selected=False,
                selection_reason="fast_replay_preview_ranked",
                matched_row_count=10,
                matched_symbol_count=1,
                requested_symbol_count=1,
                trading_day_count=1,
                signed_return_bps=Decimal("1"),
                avg_abs_return_bps=Decimal("0"),
                median_spread_bps=Decimal("0"),
                activity_score=Decimal("0"),
                coverage_score=Decimal("1"),
                ofi_pressure_score=Decimal("0"),
                microprice_bias_bps=Decimal("0"),
                spread_tail_bps=Decimal("0"),
                return_tail_abs_bps=Decimal("0"),
                impact_liquidity_penalty_bps=Decimal("0"),
                cluster_lob_activity_score=Decimal("0"),
                ofi_decay_alignment_score=Decimal("0"),
                liquidity_regime_score=Decimal("0"),
                macro_stress_veto_score=Decimal("0"),
                conformal_tail_risk_penalty_bps=Decimal("0"),
                square_root_impact_capacity_penalty_bps=Decimal("0"),
                exploration_score=Decimal(exploration_score),
                frontier_bucket="not_selected",
                microstructure_prefilter={
                    "prefilter_score": prefilter_score,
                    "is_hpairs_candidate": is_hpairs_candidate,
                    "proof_source": "prefilter_only",
                    "proof_authority": False,
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                },
            )

        ranked = sorted(
            (
                row("raw-prefilter-winner", preview_score="1", prefilter_score="999"),
                row("combined-preview-winner", preview_score="50", prefilter_score="0"),
                row(
                    "explicit-non-hpairs",
                    preview_score="100",
                    prefilter_score="1000",
                    is_hpairs_candidate=False,
                ),
            ),
            key=fast_replay._preview_rank_key,
        )
        selected = fast_replay._select_frontier_buckets(
            ranked_rows=ranked,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        self.assertEqual(ranked[0].candidate_spec_id, "combined-preview-winner")
        self.assertEqual(selected["combined-preview-winner"], "exploitation")
        self.assertNotIn("explicit-non-hpairs", selected)

    def test_frontier_selection_caps_exact_replay_with_exploration_slots(self) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=index, price=str(100 + index), ofi="0.50"
                )
                for index in range(1, 8)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-cap",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "cap"}),
                feature_schema_hash="feature-cap",
                cost_model_hash="cost-cap",
                strategy_family="hpairs-cap",
            )
        specs = tuple(
            self._spec(
                f"spec-{index}",
                symbols=["AAA"],
                max_notional_per_trade=str(2500 + index),
            )
            for index in range(8)
        )

        preview = build_fast_replay_preview(
            specs=specs,
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=8,
            min_rows_per_candidate=2,
            exploitation_count=4,
            exploration_count=2,
            exact_replay_candidate_cap=99,
        )

        self.assertEqual(len(preview.selected_candidate_spec_ids), 6)
        self.assertEqual(preview.exploitation_candidate_count, 4)
        self.assertEqual(preview.exploration_candidate_count, 2)
        self.assertEqual(preview.exact_replay_candidate_cap, 6)
        payload = preview.to_manifest_payload()
        exact_queue = payload["bounded_exact_replay_queue"]
        self.assertEqual(exact_queue["exact_replay_candidate_cap"], 6)
        self.assertEqual(exact_queue["enqueue_candidate_count"], 6)
        self.assertEqual(
            exact_queue["selected_candidate_spec_ids"],
            list(preview.selected_candidate_spec_ids),
        )
        self.assertEqual(
            exact_queue["selected_candidate_ids_by_bucket"]["all"],
            list(preview.selected_candidate_spec_ids),
        )
        self.assertEqual(
            len(exact_queue["selected_candidate_ids_by_bucket"]["exploitation"]),
            4,
        )
        self.assertEqual(
            len(exact_queue["selected_candidate_ids_by_bucket"]["exploration"]),
            2,
        )
        self.assertEqual(
            exact_queue["status"],
            "metadata_only_not_dispatched",
        )
        self.assertFalse(exact_queue["command_execution_allowed_here"])
        self.assertFalse(exact_queue["kubernetes_fanout_allowed"])
        self.assertFalse(exact_queue["db_writes_allowed"])
        self.assertFalse(exact_queue["proof_packet_upload_allowed"])
        self.assertFalse(exact_queue["promotion_allowed"])
        self.assertFalse(exact_queue["final_authority_ok"])
        self.assertEqual(
            payload["selected_candidate_ids_by_bucket"]["all"],
            list(preview.selected_candidate_spec_ids),
        )
        self.assertEqual(
            [row.frontier_bucket for row in preview.rows if row.selected],
            [
                "exploitation",
                "exploitation",
                "exploitation",
                "exploitation",
                "exploration",
                "exploration",
            ],
        )

    def test_frontier_selector_defaults_to_four_exploitation_two_diverse_exploration(
        self,
    ) -> None:
        def row(
            candidate_spec_id: str,
            *,
            preview_score: str,
            exploration_score: str,
            symbols: list[str],
        ) -> fast_replay.FastReplayPreviewRow:
            return fast_replay.FastReplayPreviewRow(
                candidate_spec_id=candidate_spec_id,
                rank=0,
                preview_score=Decimal(preview_score),
                selected=False,
                selection_reason="fast_replay_preview_ranked",
                matched_row_count=10,
                matched_symbol_count=1,
                requested_symbol_count=1,
                trading_day_count=1,
                signed_return_bps=Decimal("3"),
                avg_abs_return_bps=Decimal("1"),
                median_spread_bps=Decimal("1"),
                activity_score=Decimal("1"),
                coverage_score=Decimal("1"),
                ofi_pressure_score=Decimal("1"),
                microprice_bias_bps=Decimal("0"),
                spread_tail_bps=Decimal("1"),
                return_tail_abs_bps=Decimal("1"),
                impact_liquidity_penalty_bps=Decimal("0"),
                cluster_lob_activity_score=Decimal("1"),
                ofi_decay_alignment_score=Decimal("1"),
                liquidity_regime_score=Decimal("1"),
                macro_stress_veto_score=Decimal("0"),
                conformal_tail_risk_penalty_bps=Decimal("0"),
                square_root_impact_capacity_penalty_bps=Decimal("1"),
                exploration_score=Decimal(exploration_score),
                frontier_bucket="not_selected",
                microstructure_prefilter={
                    "is_hpairs_candidate": True,
                    "proof_source": "prefilter_only",
                    "proof_authority": False,
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                },
                candidate_lineage={
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "symbol_universe": symbols,
                    "lineage_preserved": True,
                },
            )

        ranked = sorted(
            (
                row(
                    "exploit-1",
                    preview_score="100",
                    exploration_score="1",
                    symbols=["AAA"],
                ),
                row(
                    "exploit-2",
                    preview_score="99",
                    exploration_score="1",
                    symbols=["BBB"],
                ),
                row(
                    "exploit-3",
                    preview_score="98",
                    exploration_score="1",
                    symbols=["CCC"],
                ),
                row(
                    "exploit-4",
                    preview_score="97",
                    exploration_score="1",
                    symbols=["DDD"],
                ),
                row(
                    "explore-same-high",
                    preview_score="10",
                    exploration_score="100",
                    symbols=["AAA"],
                ),
                row(
                    "explore-same-deferred",
                    preview_score="9",
                    exploration_score="99",
                    symbols=["AAA"],
                ),
                row(
                    "explore-diverse",
                    preview_score="8",
                    exploration_score="98",
                    symbols=["EEE"],
                ),
                row(
                    "budget-exhausted",
                    preview_score="7",
                    exploration_score="97",
                    symbols=["FFF"],
                ),
            ),
            key=fast_replay._preview_rank_key,
        )

        selected = fast_replay._select_frontier_buckets(
            ranked_rows=ranked,
            exploitation_count=fast_replay.FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT,
            exploration_count=fast_replay.FAST_REPLAY_DEFAULT_EXPLORATION_COUNT,
            exact_replay_candidate_cap=fast_replay.FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP,
        )
        final_rows = [
            fast_replay._row_with_rank_and_selection(
                row=item,
                rank=index,
                frontier_bucket=selected.get(item.candidate_spec_id, "not_selected"),
            )
            for index, item in enumerate(ranked, start=1)
        ]
        payloads = {item.candidate_spec_id: item.to_payload() for item in final_rows}

        self.assertEqual(
            [
                candidate_id
                for candidate_id, bucket in selected.items()
                if bucket == "exploitation"
            ],
            ["exploit-1", "exploit-2", "exploit-3", "exploit-4"],
        )
        self.assertEqual(
            [
                candidate_id
                for candidate_id, bucket in selected.items()
                if bucket == "exploration"
            ],
            ["explore-same-high", "explore-diverse"],
        )
        self.assertNotIn("explore-same-deferred", selected)
        self.assertEqual(len(selected), 6)
        self.assertEqual(
            payloads["explore-same-high"]["selection_reason"],
            "fast_replay_frontier_exploration_selected",
        )
        self.assertEqual(
            payloads["explore-diverse"]["selection_reason"],
            "fast_replay_frontier_exploration_selected",
        )
        self.assertEqual(
            payloads["explore-same-deferred"]["selection_reason"],
            "fast_replay_frontier_budget_exhausted_skipped",
        )
        self.assertEqual(
            payloads["budget-exhausted"]["frontier_selection"]["reason_code"],
            "fast_replay_frontier_budget_exhausted_skipped",
        )
        self.assertFalse(
            payloads["budget-exhausted"]["frontier_selection"]["final_authority_ok"]
        )

    def test_preview_boundary_fields_are_ranking_only_and_never_authorize_promotion(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(symbol="AAA", offset=1, price="100", ofi="0.40"),
                self._signal(symbol="AAA", offset=2, price="101", ofi="0.50"),
                self._signal(symbol="AAA", offset=3, price="102", ofi="0.60"),
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-boundary-fields",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "boundary"}),
                feature_schema_hash="feature-boundary",
                cost_model_hash="cost-boundary",
                strategy_family="hpairs-boundary",
            )

        preview = build_fast_replay_preview(
            specs=(self._spec("spec-boundary", symbols=["AAA"]),),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
        )
        payload = preview.rows[0].to_payload()
        manifest_payload = preview.to_manifest_payload()

        self.assertEqual(payload["preview_rank_score"], payload["preview_score"])
        self.assertTrue(payload["exact_replay_required"])
        self.assertTrue(payload["runtime_ledger_required"])
        self.assertIn("ranking_only_reasons", payload)
        self.assertIn("risk_veto_reasons", payload)
        self.assertIn(
            "exact_replay_required_before_any_promotion_claim",
            payload["ranking_only_reasons"],
        )
        self.assertIn(
            "runtime_ledger_required_before_any_profitability_claim",
            payload["ranking_only_reasons"],
        )
        runtime_handoff = payload["runtime_ledger_lineage_materialization_handoff"]
        self.assertEqual(
            runtime_handoff["schema_version"],
            fast_replay.FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION,
        )
        self.assertTrue(runtime_handoff["runtime_ledger_required"])
        self.assertTrue(runtime_handoff["source_backed_runtime_ledger_required"])
        self.assertTrue(
            runtime_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertFalse(runtime_handoff["promotion_allowed"])
        self.assertFalse(runtime_handoff["final_authority_ok"])
        self.assertIn(
            "closed_round_trip_ledger",
            runtime_handoff["required_materialized_artifacts"],
        )
        self.assertIn(
            "route_tca_observations",
            runtime_handoff["required_materialized_artifacts"],
        )
        self.assertIn(
            "broker_execution_semantics_parity",
            runtime_handoff["required_semantic_parity_checks"],
        )
        self.assertIn(
            "live_paper_runtime_ledger_required",
            runtime_handoff["lineage_blockers"],
        )
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["frontier_selection"]["promotion_allowed"])
        self.assertFalse(payload["frontier_selection"]["final_authority_ok"])
        boundary = manifest_payload["ranking_authority_boundary"]
        self.assertEqual(boundary["preview_rank_score_field"], "preview_rank_score")
        self.assertTrue(boundary["exact_replay_required"])
        self.assertTrue(boundary["runtime_ledger_required"])
        self.assertFalse(boundary["ranking_output_can_authorize_promotion"])
        self.assertEqual(
            manifest_payload["throughput_limits"]["max_exact_replay_candidates"], 6
        )
        self.assertLessEqual(
            manifest_payload["throughput_limits"]["exact_replay_candidate_cap"], 6
        )
        self.assertEqual(manifest_payload["throughput_limits"]["max_local_workers"], 2)
        self.assertFalse(
            manifest_payload["throughput_limits"]["kubernetes_fanout_allowed"]
        )
        exact_queue = manifest_payload["bounded_exact_replay_queue"]
        self.assertEqual(
            exact_queue["candidate_command_contract"]["source"],
            "selected_candidate_spec_ids",
        )
        self.assertFalse(
            exact_queue["candidate_command_contract"]["command_execution_allowed_here"]
        )
        self.assertTrue(exact_queue["preview_only"])
        self.assertTrue(exact_queue["research_ranking_only"])
        self.assertFalse(exact_queue["promotion_authority"])
        self.assertFalse(exact_queue["final_authority_ok"])
        queue_handoff = exact_queue["runtime_ledger_lineage_materialization_handoff"]
        self.assertEqual(queue_handoff["candidate_count"], 1)
        self.assertEqual(
            queue_handoff["candidates"][0]["candidate_spec_id"], "spec-boundary"
        )
        self.assertTrue(
            queue_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertFalse(queue_handoff["command_execution_allowed_here"])
        self.assertFalse(queue_handoff["db_writes_allowed"])
        self.assertFalse(queue_handoff["proof_packet_upload_allowed"])
        self.assertFalse(queue_handoff["promotion_allowed"])
        self.assertIn(
            "arxiv-2603.21330",
            {source["source_id"] for source in queue_handoff["source_papers"]},
        )

    def test_frontier_path_has_no_kubernetes_or_database_execution_imports(
        self,
    ) -> None:
        module_path = Path(fast_replay.__file__)
        parsed = ast.parse(module_path.read_text(encoding="utf-8"))
        disallowed_import_roots = {
            "asyncpg",
            "kubernetes",
            "psycopg",
            "psycopg2",
            "sqlalchemy",
            "subprocess",
        }
        imported_roots: set[str] = set()
        for node in ast.walk(parsed):
            if isinstance(node, ast.Import):
                imported_roots.update(
                    alias.name.split(".", maxsplit=1)[0] for alias in node.names
                )
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                imported_roots.add(node.module.split(".", maxsplit=1)[0])

        self.assertTrue(disallowed_import_roots.isdisjoint(imported_roots))

    def test_robust_lower_percentile_utility_ranks_ahead_of_mean_only_score(
        self,
    ) -> None:
        def row(
            candidate_spec_id: str,
            *,
            preview_score: str,
            robust_utility: str,
        ) -> fast_replay.FastReplayPreviewRow:
            return fast_replay.FastReplayPreviewRow(
                candidate_spec_id=candidate_spec_id,
                rank=0,
                preview_score=Decimal(preview_score),
                selected=False,
                selection_reason="fast_replay_preview_ranked",
                matched_row_count=10,
                matched_symbol_count=1,
                requested_symbol_count=1,
                trading_day_count=1,
                signed_return_bps=Decimal("1"),
                avg_abs_return_bps=Decimal("0"),
                median_spread_bps=Decimal("0"),
                activity_score=Decimal("0"),
                coverage_score=Decimal("1"),
                ofi_pressure_score=Decimal("0"),
                microprice_bias_bps=Decimal("0"),
                spread_tail_bps=Decimal("0"),
                return_tail_abs_bps=Decimal("0"),
                impact_liquidity_penalty_bps=Decimal("0"),
                cluster_lob_activity_score=Decimal("0"),
                ofi_decay_alignment_score=Decimal("0"),
                liquidity_regime_score=Decimal("1"),
                macro_stress_veto_score=Decimal("0"),
                conformal_tail_risk_penalty_bps=Decimal("0"),
                square_root_impact_capacity_penalty_bps=Decimal("0"),
                exploration_score=Decimal("0"),
                frontier_bucket="not_selected",
                microstructure_prefilter={
                    "is_hpairs_candidate": True,
                    "proof_source": "prefilter_only",
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                },
                robust_lower_percentile_post_cost_utility_bps=Decimal(robust_utility),
                bootstrap_lower_percentile_post_cost_utility_bps=Decimal(
                    robust_utility
                ),
            )

        ranked = sorted(
            (
                row("mean-only-tail-risk", preview_score="100", robust_utility="-5"),
                row("robust-frontier", preview_score="50", robust_utility="12"),
            ),
            key=fast_replay._preview_rank_key,
        )

        self.assertEqual(ranked[0].candidate_spec_id, "robust-frontier")
        payload = ranked[0].to_payload()
        self.assertEqual(payload["robust_lower_percentile_post_cost_utility_bps"], "12")
        self.assertIn(
            "robust_lower_percentile_post_cost_utility_used_for_ranking",
            payload["ranking_only_reasons"],
        )
        self.assertFalse(payload["promotion_allowed"])

    def test_macro_regime_impact_veto_fields_downrank_without_promotion_authority(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=1, price="100", ofi="0.50", stress=True
                ),
                self._signal(
                    symbol="AAA", offset=2, price="101", ofi="0.60", stress=True
                ),
                self._signal(
                    symbol="AAA", offset=3, price="102", ofi="0.70", stress=True
                ),
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-stress-boundary",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "stress"}),
                feature_schema_hash="feature-stress",
                cost_model_hash="cost-stress",
                strategy_family="hpairs-stress",
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec(
                    "spec-stress-boundary",
                    symbols=["AAA"],
                    max_notional_per_trade="2500000",
                ),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
        )
        payload = preview.rows[0].to_payload()

        self.assertGreater(Decimal(payload["macro_stress_veto_score"]), Decimal("0"))
        self.assertIn(
            "macro_news_stress_slice_veto_or_downrank", payload["risk_veto_reasons"]
        )
        self.assertIn(
            "macro_news_ofi_stress_slice_downranks_only",
            payload["ranking_only_reasons"],
        )
        self.assertIn(
            "square_root_impact_capacity_penalty", payload["risk_veto_reasons"]
        )
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_cost_capacity_lineage_blocks_exact_replay_selection(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
                    + timedelta(minutes=index),
                    symbol="AAA",
                    timeframe="1Min",
                    seq=index,
                    source="test",
                    payload={"price": Decimal(str(100 + index))},
                    ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
                )
                for index in range(1, 4)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-lineage-blocked",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest(
                    {"window": "lineage-blocked"}
                ),
                feature_schema_hash="feature-lineage-blocked",
                cost_model_hash="cost-lineage-blocked",
                strategy_family="hpairs-lineage-blocked",
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec(
                    "spec-lineage-blocked",
                    symbols=["AAA"],
                    max_notional_per_trade="0",
                ),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=0,
            exact_replay_candidate_cap=1,
        )

        self.assertEqual(preview.selected_candidate_spec_ids, ())
        self.assertEqual(preview.exploitation_candidate_count, 0)
        row = preview.rows[0]
        payload = row.to_payload()
        self.assertFalse(payload["selected"])
        self.assertEqual(
            payload["selection_reason"], "fast_replay_frontier_lineage_blocked"
        )
        self.assertTrue(payload["exact_replay_selection_blocked"])
        self.assertIn(
            "cost_lineage_spread_missing",
            payload["exact_replay_selection_blockers"],
        )
        self.assertIn(
            "adv_capacity_lineage_volume_missing",
            payload["exact_replay_selection_blockers"],
        )
        self.assertIn(
            "candidate_notional_lineage_missing",
            payload["exact_replay_selection_blockers"],
        )
        self.assertIn("source_backed_adv_missing", payload["lineage_blockers"])
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_replay_tape_identity_reports_lineage_blockers(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=index, price=str(100 + index), ofi="0.50"
                )
                for index in range(1, 4)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-missing-identity",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest(
                    {"window": "missing-identity"}
                ),
            )

        preview = build_fast_replay_preview(
            specs=(self._spec("spec-missing-identity", symbols=["AAA"]),),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=0,
            exact_replay_candidate_cap=1,
        )

        self.assertEqual(
            preview.selected_candidate_spec_ids, ("spec-missing-identity",)
        )
        payload = preview.rows[0].to_payload()
        self.assertEqual(
            payload["selection_reason"], "fast_replay_frontier_exploitation_selected"
        )
        self.assertIn(
            "replay_tape_cache_identity_missing_feature_schema_hash",
            payload["lineage_blockers"],
        )
        self.assertIn(
            "replay_tape_cache_identity_missing_cost_model_hash",
            payload["lineage_blockers"],
        )
        self.assertIn(
            "replay_tape_cache_identity_missing_strategy_family",
            payload["lineage_blockers"],
        )
        self.assertTrue(payload["frontier_selection"]["exact_replay_enqueue_allowed"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_frontier_selection_dedupes_equivalent_exact_replay_targets(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=index, price=str(100 + index), ofi="0.50"
                )
                for index in range(1, 6)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-dedupe",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "dedupe"}),
                feature_schema_hash="feature-dedupe",
                cost_model_hash="cost-dedupe",
                strategy_family="hpairs-dedupe",
            )
        representative = self._spec("spec-a-representative", symbols=["AAA"])
        duplicate = self._spec("spec-b-duplicate", symbols=["AAA"])
        unique = self._spec(
            "spec-c-unique",
            symbols=["AAA"],
            max_notional_per_trade="5000",
        )

        preview = build_fast_replay_preview(
            specs=(representative, duplicate, unique),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=3,
            min_rows_per_candidate=2,
            exploitation_count=3,
            exploration_count=0,
            exact_replay_candidate_cap=3,
        )

        self.assertEqual(
            preview.selected_candidate_spec_ids,
            ("spec-a-representative", "spec-c-unique"),
        )
        payloads = {row.candidate_spec_id: row.to_payload() for row in preview.rows}
        representative_payload = payloads["spec-a-representative"]
        duplicate_payload = payloads["spec-b-duplicate"]
        self.assertEqual(
            representative_payload["frontier_dedupe_status"], "representative"
        )
        self.assertEqual(
            duplicate_payload["frontier_dedupe_status"], "duplicate_filtered"
        )
        self.assertEqual(
            duplicate_payload["selection_reason"],
            "fast_replay_frontier_duplicate_filtered",
        )
        self.assertFalse(duplicate_payload["selected"])
        self.assertEqual(
            duplicate_payload["duplicate_of_candidate_spec_id"],
            "spec-a-representative",
        )
        self.assertEqual(
            representative_payload["candidate_frontier_hash"],
            duplicate_payload["candidate_frontier_hash"],
        )
        self.assertEqual(
            representative_payload["exact_replay_frontier_key"],
            duplicate_payload["exact_replay_frontier_key"],
        )
        self.assertFalse(
            duplicate_payload["frontier_dedupe_metadata"]["proof_authority"]
        )
        self.assertFalse(
            duplicate_payload["frontier_dedupe_metadata"]["promotion_allowed"]
        )
        self.assertFalse(
            duplicate_payload["frontier_dedupe_metadata"]["final_authority_ok"]
        )
        manifest_payload = preview.to_manifest_payload()
        self.assertEqual(
            manifest_payload["frontier_dedupe_policy"]["status"], "enabled"
        )
        self.assertFalse(
            manifest_payload["frontier_dedupe_policy"]["promotion_allowed"]
        )
        self.assertFalse(
            manifest_payload["frontier_dedupe_policy"]["final_authority_ok"]
        )
