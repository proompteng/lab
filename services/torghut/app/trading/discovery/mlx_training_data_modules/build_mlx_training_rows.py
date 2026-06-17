# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Training-row and ranker helpers for the MLX autoresearch proposal model."""

from __future__ import annotations

import hashlib
import importlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.capital_budget import estimate_capital_budget
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    MLX_RANKER_SCHEMA_VERSION,
    MlxRankBucketLift,
    MlxRankedCandidate,
    MlxRankedRowsPolicyResult,
    MlxRankerModel,
    MlxTrainingRow,
    MECHANISM_OVERLAY_FEATURE_NAMES as _MECHANISM_OVERLAY_FEATURE_NAMES,
    MECHANISM_OVERLAY_IDS as _MECHANISM_OVERLAY_IDS,
    PAPER_CONTRACT_FEATURE_NAMES as _PAPER_CONTRACT_FEATURE_NAMES,
    TorchArrayBackend as _TorchArrayBackend,
    artifact_present as _artifact_present,
    average_claim_confidence as _average_claim_confidence,
    bool_feature as _bool_feature,
    claim_type_count as _claim_type_count,
    daily_target_shortfall as _daily_target_shortfall,
    float_value as _float,
    format_float as _format_float,
    hard_veto_count as _hard_veto_count,
    import_array_backend as _import_array_backend,
    import_torch_array_backend as _import_torch_array_backend,
    mapping as _mapping,
    mapping_sequence as _mapping_sequence,
    mean as _mean,
    mechanism_overlay_ids as _mechanism_overlay_ids,
    params as _params,
    positive_or_default as _positive_or_default,
    requirement_present as _requirement_present,
    sequence_length as _sequence_length,
    sequence_strings as _sequence_strings,
    stable_hash as _stable_hash,
    strategy_universe_size as _strategy_universe_size,
    strings as _strings,
    truthy_contract_key_count as _truthy_contract_key_count,
    truthy_feature as _truthy_feature,
    unique_string_count as _unique_string_count,
    unique_strings as _unique_strings,
)
from .paper_contract_feature_values import (
    capital_rank_count_floor as _capital_rank_count_floor,
    deployable_lower_bound_failed_gate_count as _deployable_lower_bound_failed_gate_count,
    deployable_lower_bound_missing_count as _deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day as _deployable_lower_bound_net_pnl_per_day,
    deployable_lower_bound_proof_penalty as _deployable_lower_bound_proof_penalty,
    deployable_lower_bound_target_shortfall as _deployable_lower_bound_target_shortfall,
    family_code as _family_code,
    historical_proof_penalty as _historical_proof_penalty,
    net_pnl_per_100k_filled_notional as _net_pnl_per_100k_filled_notional,
    observed_replay_viability_penalty as _observed_replay_viability_penalty,
    paper_contract_feature_values as _paper_contract_feature_values,
    post_cost_efficiency_penalty as _post_cost_efficiency_penalty,
    proof_target_shortfall as _proof_target_shortfall,
    scalar_float as _scalar_float,
    std as _std,
    candidate_spec_capital_features,
    capital_budget_penalty,
    configured_daily_notional_capacity_penalty,
    observed_capital_penalty,
)


def build_mlx_training_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[MlxTrainingRow]:
    evidence_by_spec = {item.candidate_spec_id: item for item in evidence_bundles}
    rows: list[MlxTrainingRow] = []
    for spec in candidate_specs:
        evidence = evidence_by_spec.get(spec.candidate_spec_id)
        scorecard: Mapping[str, Any] = (
            evidence.objective_scorecard if evidence is not None else {}
        )
        feature_names = (
            "family_code",
            "required_feature_count",
            "failure_mode_count",
            "target_net_pnl_per_day",
            "required_min_daily_notional",
            "entry_minute_after_open",
            "exit_minute_after_open",
            "max_hold_seconds",
            "entry_cooldown_seconds",
            "stop_loss_bps",
            "trailing_activation_profit_bps",
            "trailing_drawdown_bps",
            "rank_count",
            "entry_order_type_prefer_limit",
            "market_order_spread_bps_max",
            "universe_size",
            "selection_mode_reversal",
            "selection_mode_continuation",
            "selection_mode_momentum",
            "selection_mode_pullback",
            "signal_motif_open_window_reversal",
            "signal_motif_open_window_continuation",
            "signal_motif_late_day",
            "signal_motif_washout",
            "max_notional_per_trade",
            "max_notional_pct_start_equity",
            "max_position_pct_equity",
            "configured_max_gross_exposure_pct_equity",
            "estimated_max_gross_exposure_pct_equity",
            "max_entries_per_session",
            "configured_daily_notional_capacity",
            "configured_daily_notional_required_ratio",
            "capital_budget_overage_ratio",
            "capital_feasible_flag",
            "history_net_pnl_per_day",
            "history_active_day_ratio",
            "history_positive_day_ratio",
            "history_max_gross_exposure_pct_equity",
            "history_min_cash",
            "history_negative_cash_observation_count",
            "history_negative_day_count",
            "history_best_day_share",
            "history_worst_day_loss",
            "history_max_drawdown",
            "history_avg_filled_notional_per_day",
            "history_avg_filled_notional_required_ratio",
            "history_net_pnl_per_100k_filled_notional",
            "history_post_cost_efficiency_penalty",
            "history_hard_veto_count",
            "history_daily_target_shortfall",
            "history_observed_replay_viability_penalty",
            "history_market_impact_stress_passed",
            "history_market_impact_stress_artifact_present",
            "history_market_impact_stress_cost_bps",
            "history_market_impact_liquidity_evidence_present",
            "history_market_impact_stress_net_pnl_per_day",
            "history_market_impact_target_shortfall",
            "history_delay_adjusted_depth_stress_passed",
            "history_delay_adjusted_depth_stress_artifact_present",
            "history_delay_adjusted_depth_stress_ms",
            "history_delay_adjusted_depth_fillable_notional_per_day",
            "history_delay_adjusted_depth_stress_net_pnl_per_day",
            "history_delay_adjusted_depth_target_shortfall",
            "history_double_oos_passed",
            "history_double_oos_artifact_present",
            "history_double_oos_independent_window_count",
            "history_double_oos_pass_rate",
            "history_double_oos_net_pnl_per_day",
            "history_double_oos_cost_shock_net_pnl_per_day",
            "history_double_oos_target_shortfall",
            "history_implementation_uncertainty_stability_passed",
            "history_implementation_uncertainty_lower_net_pnl_per_day",
            "history_deployable_lower_bound_net_pnl_per_day",
            "history_deployable_lower_bound_target_shortfall",
            "history_deployable_lower_bound_missing_count",
            "history_deployable_lower_bound_failed_gate_count",
            "history_conformal_tail_risk_required",
            "history_conformal_tail_risk_passed",
            "history_conformal_tail_risk_sample_count",
            "history_conformal_tail_risk_buffer_per_day",
            "history_conformal_tail_risk_adjusted_net_pnl_per_day",
            "history_conformal_tail_risk_target_shortfall",
            *_PAPER_CONTRACT_FEATURE_NAMES,
            *_MECHANISM_OVERLAY_FEATURE_NAMES,
        )
        paper_contract_features = _paper_contract_feature_values(spec)
        capital_features = candidate_spec_capital_features(spec)
        params = _params(spec)
        target_net_pnl_per_day = _float(spec.objective.get("target_net_pnl_per_day"))
        required_min_daily_notional = _float(
            spec.hard_vetoes.get("required_min_daily_notional")
            or spec.objective.get("min_avg_filled_notional_per_day")
        )
        avg_filled_notional_per_day = _float(
            scorecard.get("avg_filled_notional_per_day")
        )
        avg_filled_notional_required_ratio = (
            avg_filled_notional_per_day / required_min_daily_notional
            if required_min_daily_notional > 0.0
            else 0.0
        )
        configured_daily_notional_capacity = _float(
            capital_features.get("configured_daily_notional_capacity")
        )
        configured_daily_notional_required_ratio = (
            configured_daily_notional_capacity / required_min_daily_notional
            if required_min_daily_notional > 0.0
            else 0.0
        )
        observed_replay_penalty = _observed_replay_viability_penalty(
            scorecard,
            required_min_daily_notional=required_min_daily_notional,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
        market_impact_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=("market_impact_stress_net_pnl_per_day",),
        )
        delay_depth_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=("delay_adjusted_depth_stress_net_pnl_per_day",),
        )
        conformal_tail_risk_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=("conformal_tail_risk_adjusted_net_pnl_per_day",),
        )
        double_oos_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=(
                "double_oos_cost_shock_net_pnl_per_day",
                "double_oos_net_pnl_per_day",
            ),
        )
        historical_proof_penalty = _historical_proof_penalty(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
        deployable_lower_bound_net_pnl_per_day = _float(
            _deployable_lower_bound_net_pnl_per_day(scorecard)
        )
        deployable_lower_bound_target_shortfall = (
            _deployable_lower_bound_target_shortfall(
                scorecard,
                target_net_pnl_per_day=target_net_pnl_per_day,
            )
        )
        deployable_lower_bound_missing_count = _deployable_lower_bound_missing_count(
            scorecard
        )
        deployable_lower_bound_failed_gate_count = (
            _deployable_lower_bound_failed_gate_count(scorecard)
        )
        deployable_lower_bound_proof_penalty = _deployable_lower_bound_proof_penalty(
            scorecard
        )
        post_cost_efficiency_penalty = _post_cost_efficiency_penalty(scorecard)
        selection_mode = params.get("selection_mode")
        signal_motif = params.get("signal_motif")
        stop_loss_bps = _float(
            params.get("long_stop_loss_bps")
            or params.get("short_stop_loss_bps")
            or params.get("stop_loss_bps")
        )
        feature_values = (
            _family_code(spec.family_template_id),
            float(len(spec.feature_contract.get("required_features") or [])),
            float(len(spec.expected_failure_modes)),
            target_net_pnl_per_day,
            required_min_daily_notional,
            _float(params.get("entry_minute_after_open")),
            _float(params.get("exit_minute_after_open")),
            _float(params.get("max_hold_seconds")),
            _float(params.get("entry_cooldown_seconds")),
            stop_loss_bps,
            _float(
                params.get("long_trailing_stop_activation_profit_bps")
                or params.get("short_trailing_stop_activation_profit_bps")
            ),
            _float(
                params.get("long_trailing_stop_drawdown_bps")
                or params.get("short_trailing_stop_drawdown_bps")
            ),
            _positive_or_default(
                _float(params.get("top_n") or params.get("rank_count")),
                _positive_or_default(_float(params.get("max_pair_legs")), 1.0),
            ),
            _bool_feature(params.get("entry_order_type"), "prefer_limit"),
            _float(params.get("market_order_spread_bps_max") or 12),
            _strategy_universe_size(spec),
            _bool_feature(selection_mode, "reversal"),
            _bool_feature(selection_mode, "continuation"),
            _bool_feature(selection_mode, "momentum"),
            _bool_feature(selection_mode, "pullback"),
            _bool_feature(signal_motif, "open_window_reversal"),
            _bool_feature(signal_motif, "open_window_continuation"),
            _bool_feature(signal_motif, "late_day_continuation"),
            _bool_feature(signal_motif, "washout_rebound"),
            _float(capital_features.get("max_notional_per_trade")),
            _float(capital_features.get("max_notional_pct_start_equity")),
            _float(capital_features.get("max_position_pct_equity")),
            _float(capital_features.get("configured_max_gross_exposure_pct_equity")),
            _float(capital_features.get("estimated_max_gross_exposure_pct_equity")),
            _float(capital_features.get("max_entries_per_session")),
            configured_daily_notional_capacity,
            configured_daily_notional_required_ratio,
            _float(capital_features.get("capital_budget_overage_ratio")),
            _float(capital_features.get("capital_feasible_flag")),
            _float(scorecard.get("net_pnl_per_day")),
            _float(scorecard.get("active_day_ratio")),
            _float(scorecard.get("positive_day_ratio")),
            _float(scorecard.get("max_gross_exposure_pct_equity")),
            _float(scorecard.get("min_cash")),
            _float(scorecard.get("negative_cash_observation_count")),
            _float(scorecard.get("negative_day_count")),
            _float(scorecard.get("best_day_share")),
            _float(scorecard.get("worst_day_loss")),
            _float(scorecard.get("max_drawdown")),
            avg_filled_notional_per_day,
            avg_filled_notional_required_ratio,
            _net_pnl_per_100k_filled_notional(scorecard),
            post_cost_efficiency_penalty,
            _hard_veto_count(scorecard),
            _daily_target_shortfall(
                scorecard, target_net_pnl_per_day=target_net_pnl_per_day
            ),
            observed_replay_penalty,
            _truthy_feature(scorecard.get("market_impact_stress_passed")),
            _artifact_present(
                scorecard,
                singular="market_impact_stress_artifact_ref",
                plural="market_impact_stress_artifact_refs",
            ),
            _float(scorecard.get("market_impact_stress_cost_bps")),
            _truthy_feature(scorecard.get("market_impact_liquidity_evidence_present")),
            _float(scorecard.get("market_impact_stress_net_pnl_per_day")),
            market_impact_target_shortfall,
            _truthy_feature(scorecard.get("delay_adjusted_depth_stress_passed")),
            _artifact_present(
                scorecard,
                singular="delay_adjusted_depth_stress_artifact_ref",
                plural="delay_adjusted_depth_stress_artifact_refs",
            ),
            _float(scorecard.get("delay_adjusted_depth_stress_ms")),
            _float(scorecard.get("delay_adjusted_depth_fillable_notional_per_day")),
            _float(scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")),
            delay_depth_target_shortfall,
            _truthy_feature(scorecard.get("double_oos_passed")),
            _artifact_present(
                scorecard,
                singular="double_oos_artifact_ref",
                plural="double_oos_artifact_refs",
            ),
            _float(scorecard.get("double_oos_independent_window_count")),
            _float(scorecard.get("double_oos_pass_rate")),
            _float(scorecard.get("double_oos_net_pnl_per_day")),
            _float(scorecard.get("double_oos_cost_shock_net_pnl_per_day")),
            double_oos_target_shortfall,
            _truthy_feature(
                scorecard.get("implementation_uncertainty_stability_passed")
            ),
            _float(scorecard.get("implementation_uncertainty_lower_net_pnl_per_day")),
            deployable_lower_bound_net_pnl_per_day,
            deployable_lower_bound_target_shortfall,
            deployable_lower_bound_missing_count,
            deployable_lower_bound_failed_gate_count,
            _truthy_feature(scorecard.get("conformal_tail_risk_required")),
            _truthy_feature(scorecard.get("conformal_tail_risk_passed")),
            _float(scorecard.get("conformal_tail_risk_sample_count")),
            _float(scorecard.get("conformal_tail_risk_buffer_per_day")),
            _float(scorecard.get("conformal_tail_risk_adjusted_net_pnl_per_day")),
            conformal_tail_risk_target_shortfall,
            *(
                _float(paper_contract_features.get(feature_name))
                for feature_name in _PAPER_CONTRACT_FEATURE_NAMES
            ),
            *(
                _float(paper_contract_features.get(feature_name))
                for feature_name in _MECHANISM_OVERLAY_FEATURE_NAMES
            ),
        )
        target = (
            deployable_lower_bound_net_pnl_per_day
            + (_float(scorecard.get("active_day_ratio")) * 100.0)
            + (_float(scorecard.get("positive_day_ratio")) * 100.0)
            - (_float(scorecard.get("negative_day_count")) * 100.0)
            - (_float(scorecard.get("best_day_share")) * 200.0)
            - (_float(scorecard.get("worst_day_loss")) * 0.50)
            - (_float(scorecard.get("max_drawdown")) * 0.10)
            - (_hard_veto_count(scorecard) * 250.0)
            - (
                _daily_target_shortfall(
                    scorecard, target_net_pnl_per_day=target_net_pnl_per_day
                )
                * 0.10
            )
            - (deployable_lower_bound_target_shortfall * 0.25)
            - deployable_lower_bound_proof_penalty
            - observed_replay_penalty
            - post_cost_efficiency_penalty
            - historical_proof_penalty
            - capital_budget_penalty(capital_features)
            - configured_daily_notional_capacity_penalty(
                configured_daily_notional_required_ratio=configured_daily_notional_required_ratio
            )
            - observed_capital_penalty(scorecard)
        )
        rows.append(
            MlxTrainingRow(
                candidate_spec_id=spec.candidate_spec_id,
                feature_names=feature_names,
                feature_values=feature_values,
                target=target,
            )
        )
    return rows


def _normalize_matrix(
    rows: Sequence[MlxTrainingRow],
) -> tuple[list[list[float]], tuple[str, ...], tuple[float, ...], tuple[float, ...]]:
    if not rows:
        return [], (), (), ()
    feature_names = rows[0].feature_names
    columns = list(zip(*(row.feature_values for row in rows), strict=True))
    means = tuple(_mean(column) for column in columns)
    scales = tuple(
        _std(column, mean=mean) for column, mean in zip(columns, means, strict=True)
    )
    matrix = [
        [
            (value - mean) / scale
            for value, mean, scale in zip(
                row.feature_values, means, scales, strict=True
            )
        ]
        for row in rows
    ]
    return matrix, feature_names, means, scales


def train_mlx_ranker(
    rows: Sequence[MlxTrainingRow],
    *,
    backend_preference: str = "mlx",
    learning_rate: float = 0.01,
    steps: int = 256,
    l2_penalty: float = 0.001,
) -> MlxRankerModel:
    if not rows:
        raise ValueError("mlx_ranker_training_rows_required")
    matrix, feature_names, feature_means, feature_scales = _normalize_matrix(rows)
    targets = [row.target for row in rows]
    target_mean = _mean(targets)
    target_scale = _std(targets, mean=target_mean)
    normalized_targets = [(target - target_mean) / target_scale for target in targets]
    backend, xp = _import_array_backend(backend_preference)
    dtype = getattr(xp, "float32", None)
    x = (
        xp.array(matrix, dtype=dtype)
        if dtype is not None
        else xp.array(matrix, dtype=float)
    )
    y = (
        xp.array(normalized_targets, dtype=dtype)
        if dtype is not None
        else xp.array(normalized_targets, dtype=float)
    )
    feature_count = len(feature_names)
    weights = (
        xp.zeros((feature_count,), dtype=dtype)
        if dtype is not None
        else xp.zeros((feature_count,))
    )
    bias = xp.array(0.0, dtype=dtype) if dtype is not None else 0.0
    row_count = max(1, len(rows))
    for _ in range(max(1, steps)):
        predictions = x @ weights + bias
        errors = predictions - y
        gradient_w = ((x.T @ errors) * (2.0 / row_count)) + (weights * l2_penalty)
        gradient_b = errors.mean() * 2.0
        weights = weights - (gradient_w * learning_rate)
        bias = bias - (gradient_b * learning_rate)
    predictions = x @ weights + bias
    errors = predictions - y
    loss = _scalar_float((errors * errors).mean())
    weights_list = tuple(float(item) for item in cast(Sequence[Any], weights.tolist()))
    bias_value = _scalar_float(bias)
    model_seed = {
        "schema_version": MLX_RANKER_SCHEMA_VERSION,
        "feature_names": list(feature_names),
        "weights": list(weights_list),
        "bias": bias_value,
        "row_count": len(rows),
        "backend": backend,
    }
    return MlxRankerModel(
        schema_version=MLX_RANKER_SCHEMA_VERSION,
        model_id=f"mlx-ranker-v2-{_stable_hash(model_seed)[:16]}",
        backend=backend,
        feature_names=feature_names,
        feature_means=feature_means,
        feature_scales=feature_scales,
        target_mean=target_mean,
        target_scale=target_scale,
        weights=weights_list,
        bias=bias_value,
        row_count=len(rows),
        training_loss=loss,
        trained_at=datetime.now(UTC).isoformat(),
    )


def rank_training_rows(
    *,
    model: MlxRankerModel,
    rows: Sequence[MlxTrainingRow],
) -> list[MlxRankedCandidate]:
    scored: list[tuple[MlxTrainingRow, float, str]] = []
    for row in rows:
        normalized = [
            (value - mean) / scale
            for value, mean, scale in zip(
                row.feature_values,
                model.feature_means,
                model.feature_scales,
                strict=True,
            )
        ]
        normalized_score = (
            sum(
                (
                    value * weight
                    for value, weight in zip(normalized, model.weights, strict=True)
                ),
                0.0,
            )
            + model.bias
        )
        score = (normalized_score * model.target_scale) + model.target_mean
        feature_hash = _stable_hash({"features": row.to_payload()["features"]})
        scored.append((row, score, feature_hash))
    ordered = sorted(
        scored, key=lambda item: (item[1], item[0].candidate_spec_id), reverse=True
    )
    return [
        MlxRankedCandidate(
            candidate_spec_id=row.candidate_spec_id,
            score=score,
            rank=index,
            model_id=model.model_id,
            backend=model.backend,
            feature_hash=feature_hash,
        )
        for index, (row, score, feature_hash) in enumerate(ordered, start=1)
    ]


def compute_rank_bucket_lift(
    *,
    ranked_rows: Sequence[MlxRankedCandidate],
    rows: Sequence[MlxTrainingRow],
    metric_name: str = "replay_target",
    outcome_by_spec: Mapping[str, Any] | None = None,
) -> MlxRankBucketLift:
    if not ranked_rows:
        return MlxRankBucketLift(
            metric_name=metric_name,
            top_bucket_mean=0.0,
            bottom_bucket_mean=0.0,
            lift=0.0,
            status="no_ranked_rows",
        )
    row_target_by_spec = {row.candidate_spec_id: row.target for row in rows}
    outcomes = [
        _float(
            outcome_by_spec.get(item.candidate_spec_id)
            if outcome_by_spec is not None
            else row_target_by_spec.get(item.candidate_spec_id, 0.0)
        )
        for item in ranked_rows
    ]
    split_index = max(1, len(outcomes) // 2)
    top_bucket = outcomes[:split_index]
    bottom_bucket = outcomes[split_index:] or [0.0]
    top_mean = _mean(top_bucket)
    bottom_mean = _mean(bottom_bucket)
    return MlxRankBucketLift(
        metric_name=metric_name,
        top_bucket_mean=top_mean,
        bottom_bucket_mean=bottom_mean,
        lift=top_mean - bottom_mean,
    )


def rank_training_rows_with_lift_policy(
    *,
    model: MlxRankerModel,
    rows: Sequence[MlxTrainingRow],
    metric_name: str = "replay_target",
    outcome_by_spec: Mapping[str, Any] | None = None,
) -> MlxRankedRowsPolicyResult:
    ranked_rows = rank_training_rows(model=model, rows=rows)
    rank_lift = compute_rank_bucket_lift(
        ranked_rows=ranked_rows,
        rows=rows,
        metric_name=metric_name,
        outcome_by_spec=outcome_by_spec,
    )
    if rank_lift.lift >= 0:
        return MlxRankedRowsPolicyResult(
            ranked_rows=tuple(ranked_rows),
            rank_bucket_lift=rank_lift,
            model_status="active",
            selection_reason="exploitation",
        )

    feature_hash_by_spec = {
        item.candidate_spec_id: item.feature_hash for item in ranked_rows
    }
    ranked_by_fallback = sorted(
        rows,
        key=lambda row: (
            _float(
                outcome_by_spec.get(row.candidate_spec_id)
                if outcome_by_spec is not None
                else row.target
            ),
            row.candidate_spec_id,
        ),
        reverse=True,
    )
    fallback_rows = tuple(
        MlxRankedCandidate(
            candidate_spec_id=row.candidate_spec_id,
            score=_float(
                outcome_by_spec.get(row.candidate_spec_id)
                if outcome_by_spec is not None
                else row.target
            ),
            rank=index,
            model_id=model.model_id,
            backend=model.backend,
            feature_hash=feature_hash_by_spec.get(
                row.candidate_spec_id,
                _stable_hash({"features": row.to_payload()["features"]}),
            ),
        )
        for index, row in enumerate(ranked_by_fallback, start=1)
    )
    return MlxRankedRowsPolicyResult(
        ranked_rows=fallback_rows,
        rank_bucket_lift=rank_lift,
        model_status="demoted_to_heuristic",
        selection_reason="heuristic_negative_lift_fallback",
    )


def mlx_ranker_model_from_payload(payload: Mapping[str, Any]) -> MlxRankerModel:
    schema_version = str(payload.get("schema_version") or "").strip()
    if schema_version != MLX_RANKER_SCHEMA_VERSION:
        raise ValueError(f"mlx_ranker_schema_invalid:{schema_version}")
    return MlxRankerModel(
        schema_version=MLX_RANKER_SCHEMA_VERSION,
        model_id=str(payload.get("model_id") or "").strip(),
        backend=str(payload.get("backend") or "").strip(),
        feature_names=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("feature_names") or [])
        ),
        feature_means=tuple(
            float(item)
            for item in cast(Sequence[Any], payload.get("feature_means") or [])
        ),
        feature_scales=tuple(
            float(item)
            for item in cast(Sequence[Any], payload.get("feature_scales") or [])
        ),
        target_mean=float(payload.get("target_mean") or 0.0),
        target_scale=float(payload.get("target_scale") or 1.0),
        weights=tuple(
            float(item) for item in cast(Sequence[Any], payload.get("weights") or [])
        ),
        bias=float(payload.get("bias") or 0.0),
        row_count=int(payload.get("row_count") or 0),
        training_loss=float(payload.get("training_loss") or 0.0),
        trained_at=str(payload.get("trained_at") or "").strip(),
    )


__all__ = [name for name in globals() if not name.startswith("__")]
