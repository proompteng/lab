from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
# ruff: noqa: F401,F811,F821
from typing import Any
import json
import logging
import tempfile
import os
from decimal import Decimal
from functools import lru_cache
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
import string
from typing import Any, List, Literal, Optional, cast
from urllib.parse import urlsplit
from pydantic import AliasChoices, BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict
from .logging_config import configure_logging

logger: Any
FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD: dict[str, str]
_LLM_COMMITTEE_ROLES: Any

class TradingAccountLane(BaseModel):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    label: str
    mode: Literal["paper", "live"]
    api_key: Optional[str]
    secret_key: Optional[str]
    base_url: Optional[str]
    enabled: bool

def _dspy_bootstrap_artifact_hash(*args: Any, **kwargs: Any) -> Any: ...
def _http_connection_for_url(*args: Any, **kwargs: Any) -> Any: ...

class _HttpRequest:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    def header_items(*args: Any, **kwargs: Any) -> Any: ...
    def headers(*args: Any, **kwargs: Any) -> Any: ...

class _HttpResponseHandle:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    def read(*args: Any, **kwargs: Any) -> Any: ...
    def close(*args: Any, **kwargs: Any) -> Any: ...
    def __enter__(*args: Any, **kwargs: Any) -> Any: ...
    def __exit__(*args: Any, **kwargs: Any) -> Any: ...

def urlopen(*args: Any, **kwargs: Any) -> Any: ...
def _resolve_boolean_feature_flag(*args: Any, **kwargs: Any) -> Any: ...

class Settings(BaseSettings):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    app_env: Literal["dev", "stage", "prod"]
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    log_format: Literal["json", "text"]
    log_access_log: bool
    db_dsn: str
    tigerbeetle_enabled: bool
    tigerbeetle_required: bool
    tigerbeetle_cluster_id: int
    tigerbeetle_replica_addresses: str
    tigerbeetle_health_timeout_seconds: float
    tigerbeetle_rpc_timeout_seconds: float
    tigerbeetle_journal_enabled: bool
    tigerbeetle_reconcile_required: bool
    tigerbeetle_reconcile_max_age_seconds: int
    apca_api_key_id: Optional[str]
    apca_api_secret_key: Optional[str]
    apca_api_base_url: Optional[str]
    apca_data_api_base_url: Optional[str]
    trading_enabled: bool
    trading_mode: Literal["paper", "live"]
    trading_live_enabled: bool
    trading_ws_crypto_enabled: bool
    trading_universe_crypto_enabled: bool
    trading_crypto_enabled: bool
    trading_crypto_live_enabled: bool
    trading_feature_flags_enabled: bool
    trading_feature_flags_url: Optional[str]
    trading_feature_flags_timeout_ms: int
    trading_feature_flags_namespace: str
    trading_feature_flags_entity_id: str
    trading_signal_source: Literal["clickhouse"]
    trading_signal_table: str
    trading_signal_schema: Literal["auto", "envelope", "flat"]
    trading_signal_allowed_sources_raw: Optional[str]
    trading_signal_batch_size: int
    trading_session_context_warmup_signal_limit: int
    trading_signal_lookback_minutes: int
    trading_session_context_warmup_max_seconds: int
    trading_session_context_warmup_max_signals: int
    trading_signal_empty_batch_advance_seconds: int
    trading_signal_no_signal_streak_alert_threshold: int
    trading_signal_stale_lag_alert_seconds: int
    trading_signal_continuity_recovery_cycles: int
    trading_signal_bootstrap_grace_seconds: int
    trading_signal_staleness_alert_critical_reasons_raw: Optional[str]
    trading_signal_market_closed_expected_reasons_raw: Optional[str]
    trading_price_table: str
    trading_price_lookback_minutes: int
    trading_executable_quote_lookback_seconds: int
    trading_executable_quote_forward_seconds: int
    trading_alpaca_quote_fallback_enabled: bool
    trading_alpaca_quote_feed: str
    trading_alpaca_quote_timeout_seconds: float
    trading_alpaca_quote_max_age_seconds: int
    trading_alpaca_quote_fallback_market_session_required: bool
    trading_alpaca_quote_fallback_backoff_seconds: int
    trading_options_catalog_freshness_cache_seconds: int
    trading_options_catalog_freshness_exact_route_scope_enabled: bool
    trading_tca_status_lineage_sample_limit: int
    trading_poll_ms: int
    trading_reconcile_ms: int
    trading_order_feed_enabled: bool
    trading_multi_account_enabled: bool
    trading_order_feed_bootstrap_servers: Optional[str]
    trading_order_feed_security_protocol: Optional[str]
    trading_order_feed_sasl_mechanism: Optional[str]
    trading_order_feed_sasl_username: Optional[str]
    trading_order_feed_sasl_password: Optional[str]
    trading_order_feed_topic: str
    trading_order_feed_topic_v2: Optional[str]
    trading_order_feed_group_id: str
    trading_order_feed_assignment_mode: Literal["group", "manual"]
    trading_order_feed_client_id: str
    trading_order_feed_auto_offset_reset: Literal["latest", "earliest"]
    trading_order_feed_poll_ms: int
    trading_order_feed_batch_size: int
    trading_strategy_config_path: Optional[str]
    trading_strategy_config_mode: Literal["merge", "sync"]
    trading_strategy_reload_seconds: int
    trading_hypothesis_registry_path: Optional[str]
    trading_strategy_runtime_mode: Literal["legacy", "plugin_v3", "scheduler_v3"]
    trading_strategy_scheduler_enabled: bool
    trading_strategy_runtime_circuit_errors: int
    trading_strategy_runtime_circuit_cooldown_seconds: int
    trading_feature_schema_version: str
    trading_feature_normalization_version: str
    trading_forecast_router_enabled: bool
    trading_forecast_service_allowed_model_families_raw: Optional[str]
    trading_forecast_router_policy_path: Optional[str]
    trading_forecast_registry_manifest_path: Optional[str]
    trading_forecast_registry_manifest_url: Optional[str]
    trading_forecast_registry_refresh_seconds: int
    trading_forecast_calibration_stale_after_seconds: int
    trading_empirical_job_stale_after_seconds: int
    trading_empirical_jobs_health_required: bool
    trading_forecast_router_refinement_enabled: bool
    trading_feature_quality_enabled: bool
    trading_feature_max_required_null_rate: float
    trading_feature_max_staleness_ms: int
    trading_feature_max_duplicate_ratio: float
    trading_autonomy_enabled: bool
    trading_autonomy_allow_live_promotion: bool
    trading_autonomy_approval_token: Optional[str]
    trading_autonomy_gate_policy_path: Optional[str]
    trading_autonomy_interval_seconds: int
    trading_autonomy_signal_lookback_minutes: int
    trading_autonomy_artifact_dir: str
    trading_autonomy_alpha_train_prices_path: Optional[str]
    trading_autonomy_alpha_test_prices_path: Optional[str]
    trading_autonomy_alpha_gate_policy_path: Optional[str]
    trading_empirical_benchmark_parity_report_path: Optional[str]
    trading_empirical_foundation_router_parity_report_path: Optional[str]
    trading_empirical_deeplob_bdlob_report_path: Optional[str]
    trading_empirical_advisor_fallback_slo_report_path: Optional[str]
    trading_empirical_janus_event_car_path: Optional[str]
    trading_empirical_janus_hgrm_reward_path: Optional[str]
    trading_drift_governance_enabled: bool
    trading_drift_max_required_null_rate: float
    trading_drift_max_staleness_ms_p95: int
    trading_drift_max_duplicate_ratio: float
    trading_drift_max_schema_mismatch_total: int
    trading_drift_max_model_calibration_error: float
    trading_drift_max_model_llm_error_ratio: float
    trading_drift_min_performance_net_pnl: float
    trading_drift_max_performance_drawdown: float
    trading_drift_max_performance_cost_bps: float
    trading_drift_max_execution_fallback_ratio: float
    trading_drift_trigger_retrain_reason_codes_raw: Optional[str]
    trading_drift_trigger_reselection_reason_codes_raw: Optional[str]
    trading_drift_retrain_cooldown_seconds: int
    trading_drift_reselection_cooldown_seconds: int
    trading_drift_live_promotion_requires_evidence: bool
    trading_drift_live_promotion_max_evidence_age_seconds: int
    trading_drift_rollback_on_performance: bool
    trading_drift_rollback_reason_codes_raw: Optional[str]
    trading_evidence_continuity_enabled: bool
    trading_evidence_continuity_interval_seconds: int
    trading_evidence_continuity_run_limit: int
    trading_universe_source: Literal["jangar", "static"]
    trading_universe_require_non_empty_jangar: bool
    trading_universe_static_fallback_enabled: bool
    trading_universe_static_fallback_symbols_raw: Optional[str]
    trading_universe_symbol_allowlist_raw: Optional[str]
    trading_universe_max_stale_seconds: int
    trading_static_symbols_raw: Optional[str]
    trading_universe_cache_seconds: int
    trading_universe_timeout_seconds: int
    trading_default_qty: int
    trading_max_notional_per_trade: Optional[float]
    trading_min_notional_per_trade: Optional[float]
    trading_max_participation_rate: Optional[float]
    trading_execution_prefer_limit: bool
    trading_execution_max_retries: int
    trading_execution_backoff_base_seconds: float
    trading_execution_backoff_multiplier: float
    trading_execution_backoff_max_seconds: float
    trading_execution_advisor_enabled: bool
    trading_execution_advisor_live_apply_enabled: bool
    trading_execution_advisor_max_staleness_seconds: int
    trading_execution_advisor_timeout_ms: int
    trading_simulation_enabled: bool
    trading_simulation_run_id: Optional[str]
    trading_simulation_dataset_id: Optional[str]
    trading_simulation_clock_mode: Literal["live", "cursor"]
    trading_simulation_window_start: Optional[str]
    trading_simulation_window_end: Optional[str]
    trading_simulation_clock_cache_seconds: int
    trading_simulation_fetch_window_seconds: int
    trading_simulation_universe_symbols_path: Optional[str]
    trading_simulation_order_updates_topic: str
    trading_simulation_order_updates_bootstrap_servers: Optional[str]
    trading_simulation_order_updates_security_protocol: Optional[str]
    trading_simulation_order_updates_sasl_mechanism: Optional[str]
    trading_simulation_order_updates_sasl_username: Optional[str]
    trading_simulation_order_updates_sasl_password: Optional[str]
    trading_lean_backtest_upstream_url: Optional[str]
    trading_lean_shadow_upstream_url: Optional[str]
    trading_lean_strategy_shadow_upstream_url: Optional[str]
    trading_lean_backtest_enabled: bool
    trading_lean_shadow_execution_enabled: bool
    trading_lean_strategy_shadow_enabled: bool
    trading_lean_live_canary_enabled: bool
    trading_lean_lane_disable_switch: bool
    trading_lean_live_canary_crypto_only: bool
    trading_lean_live_canary_symbols_raw: Optional[str]
    trading_lean_live_canary_fallback_ratio_limit: float
    trading_lean_live_canary_hard_rollback_enabled: bool
    trading_max_position_pct_equity: Optional[float]
    trading_portfolio_notional_per_position: Optional[float]
    trading_portfolio_volatility_target: Optional[float]
    trading_portfolio_volatility_floor: float
    trading_portfolio_max_positions: Optional[int]
    trading_portfolio_max_notional_per_symbol: Optional[float]
    trading_portfolio_max_gross_exposure: Optional[float]
    trading_portfolio_max_gross_exposure_pct_equity: Optional[float]
    trading_portfolio_max_net_exposure: Optional[float]
    trading_portfolio_max_net_exposure_pct_equity: Optional[float]
    trading_allocator_enabled: bool
    trading_allocator_default_regime: str
    trading_allocator_default_budget_multiplier: float
    trading_allocator_default_capacity_multiplier: float
    trading_allocator_regime_low_confidence_threshold: float
    trading_allocator_regime_low_confidence_multiplier: float
    trading_allocator_min_multiplier: float
    trading_allocator_max_multiplier: float
    trading_allocator_max_symbol_pct_equity: Optional[float]
    trading_allocator_max_symbol_notional: Optional[float]
    trading_allocator_symbol_correlation_groups: dict[str, str]
    trading_allocator_regime_budget_multipliers: dict[str, float]
    trading_allocator_regime_capacity_multipliers: dict[str, float]
    trading_runtime_uncertainty_degrade_qty_multipliers_by_regime: dict[str, float]
    trading_runtime_uncertainty_degrade_max_participation_rate_by_regime: dict[
        str, float
    ]
    trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime: dict[
        str, float
    ]
    trading_runtime_regime_confidence_thresholds_by_entropy_band: dict[
        str, tuple[float, float]
    ]
    trading_allocator_strategy_notional_caps: dict[str, float]
    trading_allocator_symbol_notional_caps: dict[str, float]
    trading_allocator_correlation_group_caps: dict[str, float]
    trading_fragility_mode: Literal["off", "observe", "enforce"]
    trading_fragility_unknown_state: Literal["normal", "elevated", "stress", "crisis"]
    trading_fragility_elevated_threshold: float
    trading_fragility_stress_threshold: float
    trading_fragility_crisis_threshold: float
    trading_fragility_state_budget_multipliers: dict[str, float]
    trading_fragility_state_capacity_multipliers: dict[str, float]
    trading_fragility_state_participation_clamps: dict[str, float]
    trading_fragility_state_abstain_bias: dict[str, float]
    trading_cooldown_seconds: int
    trading_planned_decision_timeout_seconds: int
    trading_allow_shorts: bool
    trading_fractional_equities_enabled: bool
    trading_account_label: str
    trading_accounts_json: Optional[str]
    trading_kill_switch_enabled: bool
    trading_pipeline_mode: Literal["legacy", "simple"]
    trading_simple_max_notional_per_order: Optional[float]
    trading_simple_max_notional_per_symbol: Optional[float]
    trading_simple_max_order_pct_equity: Optional[float]
    trading_simple_max_gross_exposure_pct_equity: Optional[float]
    trading_simple_buying_power_reserve_bps: float
    trading_simple_submit_enabled: bool
    trading_live_submit_activation_expires_at: Optional[str]
    trading_simple_order_feed_telemetry_enabled: bool
    trading_simple_paper_route_probe_enabled: bool
    trading_simple_paper_route_probe_max_notional: float
    trading_simple_paper_route_probe_retry_attempt_limit: int
    trading_simple_paper_route_probe_retry_batch_limit: int
    trading_simple_paper_route_probe_retry_scan_limit: int
    trading_simple_paper_route_probe_exit_lookback_hours: int
    trading_paper_route_target_plan_url: Optional[str]
    trading_paper_route_target_plan_timeout_seconds: float
    trading_emergency_stop_enabled: bool
    trading_emergency_stop_recovery_cycles: int
    trading_rollback_signal_lag_seconds_limit: int
    trading_rollback_signal_staleness_alert_streak_limit: int
    trading_rollback_autonomy_failure_streak_limit: int
    trading_rollback_fallback_ratio_limit: float
    trading_rollback_max_drawdown_limit: float
    trading_jangar_symbols_url: Optional[str]
    trading_jangar_control_plane_status_url: Optional[str]
    trading_jangar_quant_health_url: Optional[str]
    trading_jangar_quant_health_required: bool
    trading_jangar_control_plane_timeout_seconds: float
    trading_jangar_control_plane_cache_ttl_seconds: int
    trading_jangar_quant_window: Literal["1m", "5m", "15m", "1h", "1d", "5d", "20d"]
    trading_market_context_url: Optional[str]
    trading_market_context_timeout_seconds: int
    trading_market_context_required: bool
    trading_market_context_fail_mode: Literal["shadow_only", "fail_closed"]
    trading_market_context_min_quality: float
    trading_market_context_max_staleness_seconds: int
    trading_clickhouse_url: Optional[str]
    trading_clickhouse_username: Optional[str]
    trading_clickhouse_password: Optional[str]
    trading_clickhouse_timeout_seconds: int
    trading_signal_max_executable_spread_bps: Decimal
    trading_signal_max_quote_mid_jump_bps: Decimal
    trading_signal_max_jump_with_wide_spread_bps: Decimal
    trading_readiness_dependency_cache_enabled: bool
    trading_readiness_dependency_cache_ttl_seconds: int
    trading_readiness_dependency_cache_stale_tolerance_seconds: int
    trading_alpaca_healthcheck_timeout_seconds: float
    trading_alpaca_healthcheck_retries: int
    trading_alpaca_healthcheck_backoff_seconds: float
    trading_alpaca_healthcheck_last_good_ttl_seconds: int
    trading_db_schema_graph_branch_tolerance: int
    trading_db_schema_graph_allow_divergence_roots: bool
    trading_startup_readiness_grace_seconds: int
    agents_base_url: Optional[str]
    agents_api_key: Optional[str]
    jangar_base_url: Optional[str]
    jangar_api_key: Optional[str]
    posthog_enabled: bool
    posthog_host: Optional[str]
    posthog_api_key: Optional[str]
    posthog_project_id: Optional[str]
    posthog_timeout_seconds: float
    posthog_distinct_id: str
    llm_enabled: bool
    llm_model: str
    llm_prompt_version: str
    llm_temperature: float
    llm_max_tokens: int
    llm_timeout_seconds: int
    llm_fail_mode: Literal["veto", "pass_through"]
    llm_fail_mode_enforcement: Literal["strict_veto", "configured"]
    llm_fail_open_live_approved: bool
    llm_min_confidence: float
    llm_min_calibrated_top_probability: float
    llm_min_probability_margin: float
    llm_max_uncertainty: float
    llm_max_uncertainty_band: Literal["low", "medium", "high"]
    llm_min_calibration_quality_score: float
    llm_abstain_fail_mode: Literal["veto", "pass_through"]
    llm_escalate_fail_mode: Literal["veto", "pass_through"]
    llm_quality_fail_mode: Literal["veto", "pass_through"]
    llm_adjustment_allowed: bool
    llm_max_qty_multiplier: float
    llm_min_qty_multiplier: float
    llm_shadow_mode: bool
    llm_rollout_stage: Literal[
        "stage0",
        "stage1",
        "stage2",
        "stage3",
        "stage0_baseline",
        "stage1_shadow_pilot",
        "stage2_paper_advisory",
        "stage3_controlled_live",
    ]
    llm_recent_decisions: int
    llm_circuit_max_errors: int
    llm_circuit_window_seconds: int
    llm_circuit_cooldown_seconds: int
    llm_token_budget_max: int
    llm_allowed_prompt_versions_raw: Optional[str]
    llm_allowed_models_raw: Optional[str]
    llm_evaluation_report: Optional[str]
    llm_effective_challenge_id: Optional[str]
    llm_shadow_completed_at: Optional[str]
    llm_model_version_lock: Optional[str]
    llm_adjustment_approved: bool
    llm_committee_enabled: bool
    llm_committee_roles_raw: str
    llm_committee_mandatory_roles_raw: str
    llm_committee_fail_closed_verdict: Literal["veto", "abstain"]
    llm_dspy_runtime_mode: Literal["disabled", "shadow", "active"]
    llm_dspy_artifact_hash: Optional[str]
    llm_dspy_program_name: str
    llm_dspy_signature_version: str
    llm_dspy_timeout_seconds: int
    llm_dspy_live_runtime_block_fail_mode: Literal[
        "veto", "pass_through", "pass_through_reduced_size"
    ]
    llm_dspy_live_runtime_block_qty_multiplier: float
    llm_dspy_runtime_fallback_alert_ratio: float
    llm_dspy_compile_metrics_policy_ref: str
    llm_dspy_secret_binding_ref: str
    llm_dspy_agentrun_ttl_seconds: int
    model_config: Any
    def _apply_feature_flag_overrides(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_csv_setting(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_non_negative_value(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_non_negative_map_values(*args: Any, **kwargs: Any) -> Any: ...
    def _apply_trading_defaults(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_optional_url_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_optional_nullable_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_trading_csv_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_llm_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_strategy_notional_caps(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_symbol_notional_caps(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_correlation_symbol_groups(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_correlation_group_notional_caps(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _normalize_allocator_alias_payload(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_allocator_alias_environment_parity(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _normalize_runtime_regime_confidence_thresholds_by_entropy_band(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _normalize_regime_keyed_float_map(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_runtime_uncertainty_degrade_maps(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _normalize_allocator_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_trading_source_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_allocator_scalar_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_allocator_map_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_runtime_uncertainty_degrade_map_settings(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _validate_runtime_regime_confidence_thresholds_by_entropy_band(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _validate_fragility_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_llm_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_posthog_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_tigerbeetle_settings(*args: Any, **kwargs: Any) -> Any: ...
    def _validate_tigerbeetle_settings(*args: Any, **kwargs: Any) -> Any: ...
    def model_post_init(*args: Any, **kwargs: Any) -> Any: ...
    def sqlalchemy_dsn(*args: Any, **kwargs: Any) -> Any: ...
    def trading_static_symbols(*args: Any, **kwargs: Any) -> Any: ...
    def trading_universe_static_fallback_symbols(*args: Any, **kwargs: Any) -> Any: ...
    def trading_universe_symbol_allowlist(*args: Any, **kwargs: Any) -> Any: ...
    def trading_forecast_service_allowed_model_families(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def trading_order_feed_topics(*args: Any, **kwargs: Any) -> Any: ...
    def trading_order_feed_bootstrap_server_list(*args: Any, **kwargs: Any) -> Any: ...
    def trading_order_feed_kafka_security_kwargs(*args: Any, **kwargs: Any) -> Any: ...
    def trading_simulation_order_updates_bootstrap_server_list(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def trading_simulation_order_updates_kafka_security_kwargs(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def trading_accounts(*args: Any, **kwargs: Any) -> Any: ...
    def trading_lean_live_canary_symbols(*args: Any, **kwargs: Any) -> Any: ...
    def trading_signal_staleness_alert_critical_reasons(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def trading_signal_market_closed_expected_reasons(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def trading_drift_trigger_retrain_reason_codes(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def trading_drift_trigger_reselection_reason_codes(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def trading_drift_rollback_reason_codes(*args: Any, **kwargs: Any) -> Any: ...
    def llm_allowed_models(*args: Any, **kwargs: Any) -> Any: ...
    def llm_allowed_prompt_versions(*args: Any, **kwargs: Any) -> Any: ...
    def llm_policy_exceptions(*args: Any, **kwargs: Any) -> Any: ...
    def llm_committee_roles(*args: Any, **kwargs: Any) -> Any: ...
    def llm_committee_mandatory_roles(*args: Any, **kwargs: Any) -> Any: ...
    def llm_dspy_live_runtime_gate(*args: Any, **kwargs: Any) -> Any: ...
    def llm_dspy_cutover_migration_guard(*args: Any, **kwargs: Any) -> Any: ...
    def llm_dspy_live_runtime_allowed(*args: Any, **kwargs: Any) -> Any: ...
    def llm_live_fail_open_requested(*args: Any, **kwargs: Any) -> Any: ...
    def llm_live_fail_open_requested_for_stage(*args: Any, **kwargs: Any) -> Any: ...
    def llm_effective_fail_mode_for_current_rollout(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def llm_effective_fail_mode(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_rollout_stage(*args: Any, **kwargs: Any) -> Any: ...
    def _matches_model_version_lock(*args: Any, **kwargs: Any) -> Any: ...

def _validate_fragility_map(*args: Any, **kwargs: Any) -> Any: ...
def get_settings(*args: Any, **kwargs: Any) -> Any: ...

settings: Any
