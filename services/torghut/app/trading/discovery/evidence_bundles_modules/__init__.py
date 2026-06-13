"""Public exports for app.trading.discovery.evidence_bundles_modules."""

from __future__ import annotations

from importlib import import_module

_impl = import_module(f"{__name__}.part_05_evidence_bundle_blockers")

EVIDENCE_BUNDLE_SCHEMA_VERSION = getattr(_impl, "EVIDENCE_BUNDLE_SCHEMA_VERSION")
VALID_COST_CALIBRATION_STATUSES = getattr(_impl, "VALID_COST_CALIBRATION_STATUSES")
MARKET_IMPACT_STRESS_COST_BPS = getattr(_impl, "MARKET_IMPACT_STRESS_COST_BPS")
DELAY_ADJUSTED_DEPTH_STRESS_MS = getattr(_impl, "DELAY_ADJUSTED_DEPTH_STRESS_MS")
DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS = getattr(
    _impl, "DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS"
)
DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS = getattr(
    _impl, "DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS"
)
MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT = getattr(
    _impl, "MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT"
)
REPLAY_ACTIVITY_SCORECARD_KEYS = getattr(_impl, "REPLAY_ACTIVITY_SCORECARD_KEYS")
MARKET_IMPACT_SCORECARD_KEYS = getattr(_impl, "MARKET_IMPACT_SCORECARD_KEYS")
CONFORMAL_COST_BUFFER_SCORECARD_KEYS = getattr(
    _impl, "CONFORMAL_COST_BUFFER_SCORECARD_KEYS"
)
DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS = getattr(
    _impl, "DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS"
)
FILL_SURVIVAL_SCORECARD_KEYS = getattr(_impl, "FILL_SURVIVAL_SCORECARD_KEYS")
RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS = getattr(
    _impl, "RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS"
)
BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS = getattr(
    _impl, "BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS"
)
ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS = getattr(
    _impl, "ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS"
)
OFI_RESPONSE_HORIZON_SCORECARD_KEYS = getattr(
    _impl, "OFI_RESPONSE_HORIZON_SCORECARD_KEYS"
)
ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS = getattr(
    _impl, "ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS"
)
STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS = getattr(
    _impl, "STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS"
)
_stable_hash = getattr(_impl, "_stable_hash")
_mapping = getattr(_impl, "_mapping")
_string = getattr(_impl, "_string")
_int = getattr(_impl, "_int")
_decimal = getattr(_impl, "_decimal")
_bool = getattr(_impl, "_bool")
_decimal_mapping_total = getattr(_impl, "_decimal_mapping_total")
_int_mapping = getattr(_impl, "_int_mapping")
_frontier_replay_config = getattr(_impl, "_frontier_replay_config")
_frontier_replay_params = getattr(_impl, "_frontier_replay_params")
_frontier_strategy_overrides = getattr(_impl, "_frontier_strategy_overrides")
_string_list = getattr(_impl, "_string_list")
_order_type_execution_metrics = getattr(_impl, "_order_type_execution_metrics")
_order_lifecycle_metrics = getattr(_impl, "_order_lifecycle_metrics")
_order_type_ablation_metrics = getattr(_impl, "_order_type_ablation_metrics")
_artifact_refs_from_scorecard = getattr(_impl, "_artifact_refs_from_scorecard")
_runtime_ledger_lineage_handoff = getattr(_impl, "_runtime_ledger_lineage_handoff")
_runtime_ledger_lineage_handoff_blockers = getattr(
    _impl, "_runtime_ledger_lineage_handoff_blockers"
)
_p10 = getattr(_impl, "_p10")
_delay_depth_fillability = getattr(_impl, "_delay_depth_fillability")
_sum_mapping_int_values = getattr(_impl, "_sum_mapping_int_values")
_is_synthetic_dataset_snapshot = getattr(_impl, "_is_synthetic_dataset_snapshot")
_freshness_status_from_validation_status = getattr(
    _impl, "_freshness_status_from_validation_status"
)
_scorecard_with_freshness_lineage = getattr(_impl, "_scorecard_with_freshness_lineage")
_decomposition_symbol_contribution_shares = getattr(
    _impl, "_decomposition_symbol_contribution_shares"
)
_decomposition_activity_counts = getattr(_impl, "_decomposition_activity_counts")
_enrich_scorecard_with_replay_stress_metrics = getattr(
    _impl, "_enrich_scorecard_with_replay_stress_metrics"
)
CandidateEvidenceBundle = getattr(_impl, "CandidateEvidenceBundle")
evidence_bundle_id_for_payload = getattr(_impl, "evidence_bundle_id_for_payload")
evidence_bundle_from_frontier_candidate = getattr(
    _impl, "evidence_bundle_from_frontier_candidate"
)
evidence_bundle_from_payload = getattr(_impl, "evidence_bundle_from_payload")
_requires_promotion_proof = getattr(_impl, "_requires_promotion_proof")
_delay_depth_survival_blockers = getattr(_impl, "_delay_depth_survival_blockers")
_has_artifact_ref = getattr(_impl, "_has_artifact_ref")
_order_type_execution_validation_required = getattr(
    _impl, "_order_type_execution_validation_required"
)
_order_type_execution_blockers = getattr(_impl, "_order_type_execution_blockers")
_market_impact_stress_blockers = getattr(_impl, "_market_impact_stress_blockers")
_implementation_uncertainty_blockers = getattr(
    _impl, "_implementation_uncertainty_blockers"
)
_implementation_risk_backtest_stability_required = getattr(
    _impl, "_implementation_risk_backtest_stability_required"
)
_implementation_risk_backtest_stability_blockers = getattr(
    _impl, "_implementation_risk_backtest_stability_blockers"
)
_bootstrap_robust_optimization_required = getattr(
    _impl, "_bootstrap_robust_optimization_required"
)
_bootstrap_robust_optimization_blockers = getattr(
    _impl, "_bootstrap_robust_optimization_blockers"
)
_adaptive_signal_falsification_required = getattr(
    _impl, "_adaptive_signal_falsification_required"
)
_scorecard_or_null_comparator_value = getattr(
    _impl, "_scorecard_or_null_comparator_value"
)
_adaptive_signal_falsification_blockers = getattr(
    _impl, "_adaptive_signal_falsification_blockers"
)
_ofi_response_horizon_required = getattr(_impl, "_ofi_response_horizon_required")
_route_tca_present = getattr(_impl, "_route_tca_present")
_ofi_response_horizon_blockers = getattr(_impl, "_ofi_response_horizon_blockers")
_alpha_decay_predictability_required = getattr(
    _impl, "_alpha_decay_predictability_required"
)
_alpha_decay_predictability_blockers = getattr(
    _impl, "_alpha_decay_predictability_blockers"
)
_stochastic_liquidity_resilience_required = getattr(
    _impl, "_stochastic_liquidity_resilience_required"
)
_stochastic_liquidity_resilience_blockers = getattr(
    _impl, "_stochastic_liquidity_resilience_blockers"
)
_conformal_tail_risk_blockers = getattr(_impl, "_conformal_tail_risk_blockers")
evidence_bundle_blockers = getattr(_impl, "evidence_bundle_blockers")
evidence_bundle_is_valid = getattr(_impl, "evidence_bundle_is_valid")

__all__ = [
    "EVIDENCE_BUNDLE_SCHEMA_VERSION",
    "VALID_COST_CALIBRATION_STATUSES",
    "MARKET_IMPACT_STRESS_COST_BPS",
    "DELAY_ADJUSTED_DEPTH_STRESS_MS",
    "DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS",
    "DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS",
    "MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT",
    "REPLAY_ACTIVITY_SCORECARD_KEYS",
    "MARKET_IMPACT_SCORECARD_KEYS",
    "CONFORMAL_COST_BUFFER_SCORECARD_KEYS",
    "DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS",
    "FILL_SURVIVAL_SCORECARD_KEYS",
    "RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS",
    "BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS",
    "ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS",
    "OFI_RESPONSE_HORIZON_SCORECARD_KEYS",
    "ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS",
    "STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS",
    "_stable_hash",
    "_mapping",
    "_string",
    "_int",
    "_decimal",
    "_bool",
    "_decimal_mapping_total",
    "_int_mapping",
    "_frontier_replay_config",
    "_frontier_replay_params",
    "_frontier_strategy_overrides",
    "_string_list",
    "_order_type_execution_metrics",
    "_order_lifecycle_metrics",
    "_order_type_ablation_metrics",
    "_artifact_refs_from_scorecard",
    "_runtime_ledger_lineage_handoff",
    "_runtime_ledger_lineage_handoff_blockers",
    "_p10",
    "_delay_depth_fillability",
    "_sum_mapping_int_values",
    "_is_synthetic_dataset_snapshot",
    "_freshness_status_from_validation_status",
    "_scorecard_with_freshness_lineage",
    "_decomposition_symbol_contribution_shares",
    "_decomposition_activity_counts",
    "_enrich_scorecard_with_replay_stress_metrics",
    "CandidateEvidenceBundle",
    "evidence_bundle_id_for_payload",
    "evidence_bundle_from_frontier_candidate",
    "evidence_bundle_from_payload",
    "_requires_promotion_proof",
    "_delay_depth_survival_blockers",
    "_has_artifact_ref",
    "_order_type_execution_validation_required",
    "_order_type_execution_blockers",
    "_market_impact_stress_blockers",
    "_implementation_uncertainty_blockers",
    "_implementation_risk_backtest_stability_required",
    "_implementation_risk_backtest_stability_blockers",
    "_bootstrap_robust_optimization_required",
    "_bootstrap_robust_optimization_blockers",
    "_adaptive_signal_falsification_required",
    "_scorecard_or_null_comparator_value",
    "_adaptive_signal_falsification_blockers",
    "_ofi_response_horizon_required",
    "_route_tca_present",
    "_ofi_response_horizon_blockers",
    "_alpha_decay_predictability_required",
    "_alpha_decay_predictability_blockers",
    "_stochastic_liquidity_resilience_required",
    "_stochastic_liquidity_resilience_blockers",
    "_conformal_tail_risk_blockers",
    "evidence_bundle_blockers",
    "evidence_bundle_is_valid",
]

del _impl
