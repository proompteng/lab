from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import app.trading.discovery.mlx_features as mlx_features_module
from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
    ProposalModelPolicy,
    ReplayBudget,
    RuntimeClosurePolicy,
    SnapshotPolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
)
from app.trading.discovery.family_templates import FamilyTemplate
from app.trading.discovery.mlx_features import (
    MlxCandidateDescriptor,
    descriptor_from_sweep_config,
    descriptor_numeric_vector,
)
from app.trading.discovery.mlx_proposal_models import (
    ProposalScore,
    _candidate_target,
    build_proposal_diagnostics,
    rank_candidate_descriptors,
    select_proposal_batch,
)
from app.trading.discovery.mlx_snapshot import (
    build_mlx_snapshot_manifest,
    write_mlx_signal_bundle,
    write_mlx_snapshot_manifest,
)
from app.trading.models import SignalEnvelope


def _template() -> FamilyTemplate:
    return FamilyTemplate(
        family_id="breakout_reclaim_v2",
        economic_mechanism="Breakout reclaim.",
        supported_markets=("us_equities_intraday",),
        required_features=(
            "prior_day_open45_rank",
            "cross_section_rank",
            "quote_quality",
        ),
        allowed_normalizations=("price_scaled",),
        entry_motifs=("breakout_reclaim",),
        exit_motifs=("time_exit",),
        risk_controls=("stop_loss",),
        activity_model={"min_active_day_ratio": "0.5"},
        liquidity_assumptions={"max_spread_bps": "30"},
        regime_activation_rules=({"rule_id": "regime-bull"},),
        day_veto_rules=(),
        default_hard_vetoes={},
        default_selection_objectives={},
        runtime_harness={
            "family": "breakout_continuation_consistent",
            "strategy_name": "breakout-continuation-long-v1",
            "disable_other_strategies": True,
        },
    )


def _family_plan() -> FamilyAutoresearchPlan:
    return FamilyAutoresearchPlan(
        family_template=_template(),
        seed_sweep_config=Path("seed-sweep.json"),
        max_iterations=1,
        keep_top_candidates=1,
        frontier_top_n=1,
        force_keep_top_candidate_if_all_vetoed=False,
        symbol_prune_iterations=0,
        symbol_prune_candidates=0,
        symbol_prune_min_universe_size=0,
        loss_repair_iterations=0,
        loss_repair_candidates=0,
        consistency_repair_iterations=0,
        consistency_repair_candidates=0,
        parameter_mutations={},
        strategy_override_mutations={},
    )


def _proof_metrics(net_pnl_per_day: str) -> dict[str, object]:
    return {
        "market_impact_stress_passed": True,
        "market_impact_stress_net_pnl_per_day": net_pnl_per_day,
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_net_pnl_per_day": net_pnl_per_day,
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
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": net_pnl_per_day,
        "double_oos_passed": True,
        "double_oos_net_pnl_per_day": net_pnl_per_day,
        "double_oos_cost_shock_net_pnl_per_day": net_pnl_per_day,
        "implementation_uncertainty_stability_passed": True,
        "implementation_uncertainty_lower_net_pnl_per_day": net_pnl_per_day,
        "conformal_tail_risk_passed": True,
        "conformal_tail_risk_adjusted_net_pnl_per_day": net_pnl_per_day,
    }


def _program() -> StrategyAutoresearchProgram:
    return StrategyAutoresearchProgram(
        program_id="program-1",
        description="desc",
        objective=StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("1.0"),
            min_positive_day_ratio=Decimal("0.6"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.3"),
            max_worst_day_loss=Decimal("350"),
            max_drawdown=Decimal("900"),
            require_every_day_active=True,
            min_regime_slice_pass_rate=Decimal("0.45"),
            stop_when_objective_met=True,
        ),
        snapshot_policy=SnapshotPolicy(
            bar_interval="PT1S",
            feature_set_id="torghut.mlx-autoresearch.v1",
            quote_quality_policy_id="scheduler_v3_default",
            symbol_policy="args_or_sweep",
            allow_prior_day_features=True,
            allow_cross_sectional_features=True,
        ),
        forbidden_mutations=("runtime_code_path",),
        proposal_model_policy=ProposalModelPolicy(
            enabled=True,
            mode="ranking_only",
            backend_preference="mlx",
            top_k=4,
            exploration_slots=1,
            minimum_history_rows=1,
        ),
        replay_budget=ReplayBudget(
            max_candidates_per_round=8,
            exploration_slots=1,
            max_candidates_per_frontier_run=16,
        ),
        runtime_closure_policy=RuntimeClosurePolicy(
            enabled=False,
            execute_parity_replay=True,
            execute_approval_replay=True,
            parity_window="full_window",
            approval_window="holdout",
            shadow_validation_mode="require_live_evidence",
            promotion_target="shadow",
        ),
        parity_requirements=("scheduler_v3_parity_replay",),
        promotion_policy="research_only",
        ledger_policy={"append_only": True},
        research_sources=(),
        families=(),
    )


class TestMlxAutoresearch(TestCase):
    def test_candidate_target_penalizes_observed_notional_shortfall(self) -> None:
        target = _candidate_target(
            {
                "net_pnl_per_day": "500",
                **_proof_metrics("500"),
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "avg_filled_notional_per_day": "250000",
                "required_min_daily_notional": "500000",
            }
        )

        self.assertEqual(target, 525.0)

    def test_candidate_target_prefers_deployable_lower_bound_over_raw_net(
        self,
    ) -> None:
        optimistic = _candidate_target(
            {
                "net_pnl_per_day": "1500",
                **_proof_metrics("220"),
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "avg_filled_notional_per_day": "300000",
                "required_min_daily_notional": "250000",
                "best_day_share": "0.10",
            }
        )
        robust = _candidate_target(
            {
                "net_pnl_per_day": "620",
                **_proof_metrics("580"),
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "avg_filled_notional_per_day": "300000",
                "required_min_daily_notional": "250000",
                "best_day_share": "0.10",
            }
        )
        raw_only = _candidate_target(
            {
                "net_pnl_per_day": "2500",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "avg_filled_notional_per_day": "300000",
                "required_min_daily_notional": "250000",
                "best_day_share": "0.10",
            }
        )

        self.assertLess(optimistic, robust)
        self.assertLess(raw_only, robust)

    def test_candidate_target_penalizes_execution_quality_adjusted_net(
        self,
    ) -> None:
        base = {
            "net_pnl_per_day": "900",
            **_proof_metrics("800"),
            "active_day_ratio": "1",
            "positive_day_ratio": "1",
            "avg_filled_notional_per_day": "300000",
            "required_min_daily_notional": "250000",
            "best_day_share": "0.10",
        }

        unadjusted = _candidate_target(base)
        adjusted = _candidate_target(
            {
                **base,
                "execution_quality_adjusted_window_net_pnl_per_day": "220",
            }
        )
        blocked = _candidate_target(
            {
                **base,
                "execution_quality_adjusted_window_net_pnl_per_day": "220",
                "execution_quality_penalty_bps": "25",
                "execution_quality_blockers": [
                    "market_order_share_high",
                    "queue_evidence_missing",
                ],
            }
        )

        self.assertLess(adjusted, unadjusted)
        self.assertLess(blocked, adjusted)

    def test_descriptor_inference_covers_side_rank_and_universe_fallbacks(
        self,
    ) -> None:
        short_template = FamilyTemplate(
            family_id="mean_reversion_exhaustion_short_v1",
            economic_mechanism="Exhaustion reversal.",
            supported_markets=("us_equities_intraday",),
            required_features=(),
            allowed_normalizations=(),
            entry_motifs=(),
            exit_motifs=(),
            risk_controls=(),
            activity_model={},
            liquidity_assumptions={},
            regime_activation_rules=(),
            day_veto_rules=(),
            default_hard_vetoes={},
            default_selection_objectives={},
            runtime_harness={
                "family": "mean_reversion_exhaustion_short",
                "strategy_name": "mean-reversion-short-v1",
            },
        )
        neutral_template = FamilyTemplate(
            family_id="stat_arb_pairs_v1",
            economic_mechanism="Paired statistical arbitrage.",
            supported_markets=("us_equities_intraday",),
            required_features=(),
            allowed_normalizations=(),
            entry_motifs=(),
            exit_motifs=(),
            risk_controls=(),
            activity_model={},
            liquidity_assumptions={},
            regime_activation_rules=(),
            day_veto_rules=(),
            default_hard_vetoes={},
            default_selection_objectives={},
            runtime_harness={"family": "paired_stat_arb", "strategy_name": "pairs-v1"},
        )

        self.assertEqual(
            mlx_features_module._infer_side_policy(short_template), "short"
        )
        self.assertEqual(
            mlx_features_module._infer_side_policy(neutral_template),
            "long_short",
        )
        self.assertEqual(
            mlx_features_module._infer_rank_policy(
                {"parameters": {"cross_section_signal": ["spread_z"]}},
                neutral_template,
            ),
            "cross_sectional_rank",
        )
        self.assertEqual(
            mlx_features_module._infer_rank_policy(
                {"parameters": {"rank_feature": ["momentum_z"]}},
                neutral_template,
            ),
            "rank",
        )
        self.assertEqual(
            mlx_features_module._infer_rank_policy(
                {"parameters": {}}, neutral_template
            ),
            "none",
        )
        self.assertEqual(
            mlx_features_module._infer_rank_count(
                {
                    "parameters": {},
                    "strategy_overrides": {"universe_symbols": [["NVDA", "", "AMD"]]},
                }
            ),
            2,
        )
        self.assertEqual(
            mlx_features_module._infer_rank_count(
                {
                    "parameters": {"max_entries_per_session": ["12"]},
                    "strategy_overrides": {"universe_symbols": [["NVDA", "AMD"]]},
                }
            ),
            1,
        )

    def test_build_snapshot_manifest_uses_program_snapshot_policy(self) -> None:
        manifest = build_mlx_snapshot_manifest(
            runner_run_id="run-1",
            program=_program(),
            symbols="AAPL,NVDA",
            train_days=6,
            holdout_days=2,
            full_window_start_date="2026-03-20",
            full_window_end_date="2026-04-09",
            row_counts={"receipt_count": 1, "latest_row_count": 123},
        )

        self.assertEqual(manifest.feature_set_id, "torghut.mlx-autoresearch.v1")
        self.assertEqual(manifest.quote_quality_policy_id, "scheduler_v3_default")
        self.assertEqual(manifest.symbols, ("AAPL", "NVDA"))
        self.assertEqual(manifest.row_counts["latest_row_count"], 123)

        with TemporaryDirectory() as tmpdir:
            path = write_mlx_snapshot_manifest(Path(tmpdir) / "manifest.json", manifest)
            self.assertTrue(path.exists())

    def test_descriptor_from_sweep_config_captures_runtime_relevant_fields(
        self,
    ) -> None:
        family_plan = _family_plan()
        descriptor = descriptor_from_sweep_config(
            candidate_id="cand-1",
            family_plan=family_plan,
            sweep_config={
                "parameters": {
                    "leader_reclaim_start_minutes_since_open": ["45"],
                    "max_hold_seconds": ["900"],
                    "max_entries_per_session": ["2"],
                    "top_n": ["2"],
                    "entry_order_type": ["prefer_limit"],
                    "market_order_spread_bps_max": ["6"],
                },
                "strategy_overrides": {
                    "max_notional_per_trade": ["315900.20"],
                    "max_position_pct_equity": ["10.0"],
                    "normalization_regime": ["price_scaled"],
                },
            },
        )

        self.assertEqual(descriptor.family_template_id, "breakout_reclaim_v2")
        self.assertEqual(descriptor.entry_window_start_minute, 45)
        self.assertEqual(descriptor.max_hold_minutes, 15)
        self.assertEqual(descriptor.rank_count, 2)
        self.assertTrue(descriptor.requires_prev_day_features)
        self.assertTrue(descriptor.requires_cross_sectional_features)
        self.assertFalse(descriptor.capital_feasible)
        self.assertGreater(float(descriptor.capital_budget_overage_ratio), 0.0)
        self.assertEqual(descriptor.expected_fill_mode, "prefer_limit")
        self.assertEqual(descriptor.market_order_spread_bps_max, "6")
        self.assertEqual(len(descriptor_numeric_vector(descriptor)), 14)

    def test_write_mlx_signal_bundle_persists_signal_rows(self) -> None:
        rows = [
            SignalEnvelope(
                event_ts=datetime(2026, 4, 9, 13, 30, tzinfo=UTC),
                symbol="NVDA",
                seq=1,
                source="ta",
                timeframe="1Sec",
                payload={"price": "123.45", "spread_bps": "8.2"},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 4, 9, 13, 31, tzinfo=UTC),
                symbol="AMAT",
                seq=2,
                source="ta",
                timeframe="1Sec",
                payload={"price": "180.10", "spread_bps": "6.4"},
            ),
        ]

        with TemporaryDirectory() as tmpdir:
            bundle_path = Path(tmpdir) / "signals.jsonl"
            stats = write_mlx_signal_bundle(bundle_path, rows)
            payload = bundle_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(stats.row_count, 2)
        self.assertEqual(stats.symbol_count, 2)
        self.assertEqual(stats.first_event_ts, "2026-04-09 13:30:00+00:00")
        self.assertEqual(stats.last_event_ts, "2026-04-09 13:31:00+00:00")
        self.assertEqual(len(payload), 2)
        self.assertIn('"symbol": "NVDA"', payload[0])

    def test_rank_candidate_descriptors_orders_candidates_from_history_signal(
        self,
    ) -> None:
        family_plan = _family_plan()
        strong = descriptor_from_sweep_config(
            candidate_id="strong",
            family_plan=family_plan,
            sweep_config={
                "parameters": {"leader_reclaim_start_minutes_since_open": ["45"]},
                "strategy_overrides": {},
            },
        )
        weak = descriptor_from_sweep_config(
            candidate_id="weak",
            family_plan=family_plan,
            sweep_config={
                "parameters": {"leader_reclaim_start_minutes_since_open": ["0"]},
                "strategy_overrides": {},
            },
        )
        history_rows = [
            {
                "entry_window_start_minute": 45,
                "entry_window_end_minute": 75,
                "max_hold_minutes": 30,
                "rank_count": 1,
                "requires_prev_day_features": True,
                "requires_cross_sectional_features": True,
                "requires_quote_quality_gate": True,
                "net_pnl_per_day": "600",
                **_proof_metrics("600"),
                "active_day_ratio": "1.0",
                "positive_day_ratio": "1.0",
                "best_day_share": "0.2",
                "hard_vetoes": [],
            },
            {
                "entry_window_start_minute": 0,
                "entry_window_end_minute": 30,
                "max_hold_minutes": 30,
                "rank_count": 1,
                "requires_prev_day_features": False,
                "requires_cross_sectional_features": False,
                "requires_quote_quality_gate": False,
                "net_pnl_per_day": "-50",
                **_proof_metrics("-50"),
                "active_day_ratio": "0.2",
                "positive_day_ratio": "0.2",
                "best_day_share": "0.8",
                "hard_vetoes": ["bad"],
            },
        ]

        ranked = rank_candidate_descriptors(
            descriptors=[weak, strong],
            history_rows=history_rows,
            policy=_program().proposal_model_policy,
        )

        self.assertEqual(ranked[0].candidate_id, "strong")
        self.assertEqual(ranked[0].rank, 1)
        self.assertIn(ranked[0].backend, {"mlx", "numpy-fallback"})

    def test_rank_candidate_descriptors_respects_numpy_backend_preference(self) -> None:
        family_plan = _family_plan()
        descriptor = descriptor_from_sweep_config(
            candidate_id="strong",
            family_plan=family_plan,
            sweep_config={
                "parameters": {"leader_reclaim_start_minutes_since_open": ["45"]},
                "strategy_overrides": {},
            },
        )
        import numpy as np

        with (
            patch(
                "app.trading.discovery.mlx_proposal_models._import_mlx_backend",
                side_effect=AssertionError("mlx backend should not be used"),
            ),
            patch(
                "app.trading.discovery.mlx_proposal_models._import_numpy_backend",
                return_value=("numpy-fallback", np),
            ),
        ):
            ranked = rank_candidate_descriptors(
                descriptors=[descriptor],
                history_rows=[],
                policy=ProposalModelPolicy(
                    enabled=True,
                    mode="ranking_only",
                    backend_preference="numpy-fallback",
                    top_k=4,
                    exploration_slots=1,
                    minimum_history_rows=1,
                ),
            )

        self.assertEqual(ranked[0].backend, "numpy-fallback")

    def test_rank_candidate_descriptors_uses_capital_prior_during_cold_start(
        self,
    ) -> None:
        family_plan = _family_plan()
        over_budget = descriptor_from_sweep_config(
            candidate_id="aaa-over-budget",
            family_plan=family_plan,
            sweep_config={
                "parameters": {"max_gross_exposure_pct_equity": ["10.0"]},
                "strategy_overrides": {
                    "max_position_pct_equity": ["10.0"],
                    "max_notional_per_trade": ["315900.20"],
                },
            },
        )
        feasible = descriptor_from_sweep_config(
            candidate_id="zzz-feasible",
            family_plan=family_plan,
            sweep_config={
                "parameters": {"max_gross_exposure_pct_equity": ["1.0"]},
                "strategy_overrides": {
                    "max_position_pct_equity": ["0.50"],
                    "max_notional_per_trade": ["7500"],
                },
            },
        )

        ranked = rank_candidate_descriptors(
            descriptors=[over_budget, feasible],
            history_rows=[],
            policy=ProposalModelPolicy(
                enabled=True,
                mode="ranking_only",
                backend_preference="numpy-fallback",
                top_k=4,
                exploration_slots=1,
                minimum_history_rows=2,
            ),
        )

        self.assertEqual(ranked[0].candidate_id, "zzz-feasible")
        self.assertEqual(ranked[0].mode, "ranking_only_cold_start_capital_prior")

    def test_rank_candidate_descriptors_demotes_negative_lift_model(self) -> None:
        family_plan = _family_plan()
        weak = descriptor_from_sweep_config(
            candidate_id="aaa-weak",
            family_plan=family_plan,
            sweep_config={
                "parameters": {"leader_reclaim_start_minutes_since_open": ["45"]},
                "strategy_overrides": {},
            },
        )
        strong = descriptor_from_sweep_config(
            candidate_id="zzz-strong",
            family_plan=family_plan,
            sweep_config={
                "parameters": {"leader_reclaim_start_minutes_since_open": ["45"]},
                "strategy_overrides": {},
            },
        )
        shared_history = {
            "entry_window_start_minute": 45,
            "entry_window_end_minute": 75,
            "max_hold_minutes": 30,
            "rank_count": 1,
            "requires_prev_day_features": True,
            "requires_cross_sectional_features": True,
            "requires_quote_quality_gate": True,
            "best_day_share": "0.2",
            "hard_vetoes": [],
        }
        ranked = rank_candidate_descriptors(
            descriptors=[weak, strong],
            history_rows=[
                {
                    **shared_history,
                    "candidate_id": "aaa-weak",
                    "net_pnl_per_day": "-75",
                    **_proof_metrics("-75"),
                    "active_day_ratio": "0.4",
                    "positive_day_ratio": "0.2",
                },
                {
                    **shared_history,
                    "candidate_id": "zzz-strong",
                    "net_pnl_per_day": "650",
                    **_proof_metrics("650"),
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                },
            ],
            policy=ProposalModelPolicy(
                enabled=True,
                mode="ranking_only",
                backend_preference="numpy-fallback",
                top_k=4,
                exploration_slots=1,
                minimum_history_rows=1,
            ),
        )

        self.assertEqual(ranked[0].candidate_id, "zzz-strong")
        self.assertEqual(
            {item.mode for item in ranked},
            {"heuristic_negative_lift_fallback"},
        )

    def test_select_proposal_batch_reserves_exploration_slot_for_diversity(
        self,
    ) -> None:
        long_descriptor = MlxCandidateDescriptor(
            descriptor_id="desc-long",
            candidate_id="long-1",
            family_template_id="breakout_reclaim_v2",
            runtime_family="breakout_continuation_consistent",
            strategy_name="breakout-continuation-long-v1",
            side_policy="long",
            entry_window_start_minute=45,
            entry_window_end_minute=75,
            max_hold_minutes=30,
            entry_type="breakout_reclaim",
            exit_type="time_exit",
            rank_policy="rank",
            rank_count=1,
            gross_budget_usd="30000",
            per_leg_budget_usd="15000",
            normalization_regime="runtime_default",
            regime_gate_id="regime-bull",
            requires_prev_day_features=True,
            requires_cross_sectional_features=True,
            requires_quote_quality_gate=True,
            expected_fill_mode="market",
            approval_path="scheduler_v3",
        )
        similar_long_descriptor = MlxCandidateDescriptor(
            descriptor_id="desc-long-2",
            candidate_id="long-2",
            family_template_id="breakout_reclaim_v2",
            runtime_family="breakout_continuation_consistent",
            strategy_name="breakout-continuation-long-v1",
            side_policy="long",
            entry_window_start_minute=46,
            entry_window_end_minute=76,
            max_hold_minutes=30,
            entry_type="breakout_reclaim",
            exit_type="time_exit",
            rank_policy="rank",
            rank_count=1,
            gross_budget_usd="30000",
            per_leg_budget_usd="15000",
            normalization_regime="runtime_default",
            regime_gate_id="regime-bull",
            requires_prev_day_features=True,
            requires_cross_sectional_features=True,
            requires_quote_quality_gate=True,
            expected_fill_mode="market",
            approval_path="scheduler_v3",
        )
        short_descriptor = MlxCandidateDescriptor(
            descriptor_id="desc-short",
            candidate_id="short-1",
            family_template_id="exhaustion_short_v1",
            runtime_family="mean_reversion_exhaustion_short",
            strategy_name="mean-reversion-exhaustion-short-v1",
            side_policy="short",
            entry_window_start_minute=45,
            entry_window_end_minute=75,
            max_hold_minutes=30,
            entry_type="fade_exhaustion",
            exit_type="time_exit",
            rank_policy="rank",
            rank_count=1,
            gross_budget_usd="30000",
            per_leg_budget_usd="15000",
            normalization_regime="runtime_default",
            regime_gate_id="regime-bear",
            requires_prev_day_features=True,
            requires_cross_sectional_features=False,
            requires_quote_quality_gate=True,
            expected_fill_mode="market",
            approval_path="scheduler_v3",
        )
        proposal_scores = [
            ProposalScore(
                "long-1", "desc-long", 10.0, 1, "numpy-fallback", "ranking_only"
            ),
            ProposalScore(
                "long-2", "desc-long-2", 9.0, 2, "numpy-fallback", "ranking_only"
            ),
            ProposalScore(
                "short-1", "desc-short", 1.0, 3, "numpy-fallback", "ranking_only"
            ),
        ]

        selected = select_proposal_batch(
            descriptors=[long_descriptor, similar_long_descriptor, short_descriptor],
            proposal_scores=proposal_scores,
            limit=2,
            top_k=1,
            exploration_slots=1,
        )

        self.assertEqual(
            [item.candidate_id for item in selected], ["long-1", "short-1"]
        )
        self.assertEqual(selected[0].selection_reason, "exploitation")
        self.assertEqual(selected[1].selection_reason, "exploration")

    def test_select_proposal_batch_prefers_capital_feasible_candidates(self) -> None:
        infeasible_descriptor = MlxCandidateDescriptor(
            descriptor_id="desc-infeasible",
            candidate_id="infeasible",
            family_template_id="breakout_reclaim_v2",
            runtime_family="breakout_continuation_consistent",
            strategy_name="breakout-continuation-long-v1",
            side_policy="long",
            entry_window_start_minute=45,
            entry_window_end_minute=75,
            max_hold_minutes=30,
            entry_type="breakout_reclaim",
            exit_type="time_exit",
            rank_policy="rank",
            rank_count=1,
            gross_budget_usd="315900.20",
            per_leg_budget_usd="315900.20",
            normalization_regime="runtime_default",
            regime_gate_id="regime-bull",
            requires_prev_day_features=True,
            requires_cross_sectional_features=True,
            requires_quote_quality_gate=True,
            expected_fill_mode="market",
            approval_path="scheduler_v3",
            max_position_pct_equity="10.0",
            estimated_max_gross_exposure_pct_equity="10.0",
            capital_budget_overage_ratio="18.0",
            capital_feasible=False,
        )
        feasible_descriptor = MlxCandidateDescriptor(
            descriptor_id="desc-feasible",
            candidate_id="feasible",
            family_template_id="intraday_tsmom_v2",
            runtime_family="intraday_tsmom_consistent",
            strategy_name="intraday-tsmom-profit-v3",
            side_policy="long",
            entry_window_start_minute=45,
            entry_window_end_minute=75,
            max_hold_minutes=30,
            entry_type="momentum",
            exit_type="time_exit",
            rank_policy="rank",
            rank_count=1,
            gross_budget_usd="30000",
            per_leg_budget_usd="30000",
            normalization_regime="runtime_default",
            regime_gate_id="regime-bull",
            requires_prev_day_features=True,
            requires_cross_sectional_features=True,
            requires_quote_quality_gate=True,
            expected_fill_mode="market",
            approval_path="scheduler_v3",
            max_position_pct_equity="1.0",
            estimated_max_gross_exposure_pct_equity="1.0",
            capital_budget_overage_ratio="0",
            capital_feasible=True,
        )

        selected = select_proposal_batch(
            descriptors=[infeasible_descriptor, feasible_descriptor],
            proposal_scores=[
                ProposalScore(
                    "infeasible",
                    "desc-infeasible",
                    1000.0,
                    1,
                    "numpy-fallback",
                    "ranking_only",
                ),
                ProposalScore(
                    "feasible",
                    "desc-feasible",
                    10.0,
                    2,
                    "numpy-fallback",
                    "ranking_only",
                ),
            ],
            limit=1,
            top_k=1,
            exploration_slots=0,
        )

        self.assertEqual(selected[0].candidate_id, "feasible")
        self.assertTrue(selected[0].capital_feasible)

    def test_build_proposal_diagnostics_reports_lift_and_failure_tables(self) -> None:
        descriptors = [
            MlxCandidateDescriptor(
                descriptor_id="desc-a",
                candidate_id="cand-a",
                family_template_id="breakout_reclaim_v2",
                runtime_family="breakout_continuation_consistent",
                strategy_name="breakout-continuation-long-v1",
                side_policy="long",
                entry_window_start_minute=45,
                entry_window_end_minute=75,
                max_hold_minutes=30,
                entry_type="breakout_reclaim",
                exit_type="time_exit",
                rank_policy="rank",
                rank_count=1,
                gross_budget_usd="30000",
                per_leg_budget_usd="15000",
                normalization_regime="runtime_default",
                regime_gate_id="regime-bull",
                requires_prev_day_features=True,
                requires_cross_sectional_features=True,
                requires_quote_quality_gate=True,
                expected_fill_mode="market",
                approval_path="scheduler_v3",
            ),
            MlxCandidateDescriptor(
                descriptor_id="desc-b",
                candidate_id="cand-b",
                family_template_id="exhaustion_short_v1",
                runtime_family="mean_reversion_exhaustion_short",
                strategy_name="mean-reversion-exhaustion-short-v1",
                side_policy="short",
                entry_window_start_minute=45,
                entry_window_end_minute=75,
                max_hold_minutes=30,
                entry_type="fade_exhaustion",
                exit_type="time_exit",
                rank_policy="rank",
                rank_count=1,
                gross_budget_usd="30000",
                per_leg_budget_usd="15000",
                normalization_regime="runtime_default",
                regime_gate_id="regime-bear",
                requires_prev_day_features=True,
                requires_cross_sectional_features=False,
                requires_quote_quality_gate=True,
                expected_fill_mode="market",
                approval_path="scheduler_v3",
            ),
        ]
        scores = [
            ProposalScore("cand-a", "desc-a", 8.0, 1, "numpy-fallback", "ranking_only"),
            ProposalScore("cand-b", "desc-b", 2.0, 2, "numpy-fallback", "ranking_only"),
        ]
        selected = select_proposal_batch(
            descriptors=descriptors,
            proposal_scores=scores,
            limit=2,
            top_k=1,
            exploration_slots=1,
        )

        diagnostics = build_proposal_diagnostics(
            descriptors=descriptors,
            proposal_scores=scores,
            history_rows=[
                {
                    "candidate_id": "cand-a",
                    "net_pnl_per_day": "-25",
                    **_proof_metrics("-25"),
                    "active_day_ratio": "0.60",
                    "positive_day_ratio": "0.20",
                    "objective_met": False,
                    "promotion_status": "blocked_pending_runtime_parity",
                    "status": "discard",
                },
                {
                    "candidate_id": "cand-b",
                    "net_pnl_per_day": "410",
                    **_proof_metrics("410"),
                    "active_day_ratio": "0.95",
                    "positive_day_ratio": "0.80",
                    "objective_met": True,
                    "promotion_status": "blocked_pending_runtime_parity",
                    "status": "keep",
                },
            ],
            selected_candidates=selected,
        )

        self.assertEqual(diagnostics.parity_matrix["replayed_count"], 2)
        self.assertEqual(diagnostics.selected_candidates[0].candidate_id, "cand-a")
        self.assertEqual(
            diagnostics.selected_candidates[1].selection_reason, "exploration"
        )
        self.assertTrue(diagnostics.rank_bucket_lift)
        self.assertEqual(diagnostics.worst_false_positives[0]["candidate_id"], "cand-a")
        self.assertEqual(diagnostics.best_false_negatives[0]["candidate_id"], "cand-b")
