"""Type-only declarations for app.main compatibility proxies."""

from __future__ import annotations

from typing import Any

__all__: tuple[str, ...] = (
    "app",
    "_ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS",
    "_ALPACA_HEALTH_CACHE_LOCK",
    "_ALPACA_HEALTH_STATE",
    "_OPTIONS_CATALOG_FRESHNESS_CACHE",
    "_OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "_PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL",
    "_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS",
    "_PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK",
    "_READINESS_PROMOTION_AUTHORITY_KEYS",
    "_RETRYABLE_TCA_RECOMPUTE_SQLSTATES",
    "_SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "_TRADING_DEPENDENCY_HEALTH_CACHE",
    "_TRADING_DEPENDENCY_HEALTH_CACHE_LOCK",
    "_TRADING_HEALTH_SURFACE_EVALUATIONS",
    "_TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR",
    "_TRADING_HEALTH_SURFACE_EVALUATION_LOCK",
    "_TRADING_HEALTH_SURFACE_PAYLOAD_CACHE",
    "_TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
    "_TRADING_STATUS_READ_BUDGET_SECONDS",
    "_TradingStatusReadBudget",
    "_ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS",
    "_active_runtime_revision",
    "_aggregate_tca_rows",
    "_alpaca_cached_last_good",
    "_alpaca_endpoint_class",
    "_alpaca_failure_status",
    "_alpaca_probe_account",
    "_append_unique_reason",
    "_apply_status_read_statement_timeout",
    "_assert_dspy_cutover_migration_guard",
    "_budget_exhausted_live_submission_gate_payload",
    "_budget_exhausted_options_catalog_freshness_payload",
    "_budget_unavailable_hypothesis_runtime_payload",
    "_budget_unavailable_llm_evaluation_payload",
    "_budget_unavailable_tca_summary_payload",
    "_budget_unavailable_tigerbeetle_ledger_payload",
    "_build_autonomy_bridge_status",
    "_build_autonomy_capital_replay_projection",
    "_build_capital_reentry_cohort_ledger_payload",
    "_build_capital_replay_projection_payload",
    "_build_clock_settlement_payload",
    "_build_consumer_evidence_receipt_projection",
    "_build_control_plane_contract",
    "_build_current_evidence_epoch",
    "_build_evidence_clock_payloads",
    "_build_freshness_carry_ledger_payload",
    "_build_hypothesis_runtime_payload",
    "_build_jangar_contract_graduation_ref",
    "_build_jangar_execution_trust_admission_ref",
    "_build_jangar_material_verdict_ref",
    "_build_jangar_reliability_settlement_ref",
    "_build_live_submission_gate_payload",
    "_build_persisted_vnext_status",
    "_build_profit_carry_passport_ledger_payload",
    "_build_profit_freshness_frontier_payload",
    "_build_profit_repair_settlement_ledger_payload",
    "_build_profit_signal_quorum_payload",
    "_build_profitability_proof_floor_payload",
    "_build_quality_adjusted_profit_frontier_payload",
    "_build_rejected_signal_outcome_learning_payload",
    "_build_renewal_bond_profit_escrow_payload",
    "_build_repair_bid_settlement_payload",
    "_build_repair_outcome_dividend_ledger_payload",
    "_build_repair_receipt_frontier_payload",
    "_build_route_evidence_clearinghouse_payload",
    "_build_route_image_proof_summary",
    "_build_route_reacquisition_board_payload",
    "_build_route_warrant_exchange_payload",
    "_build_routeability_repair_acceptance_ledger_payload",
    "_build_shadow_first_runtime_payload",
    "_build_shadow_first_toggle_parity",
    "_build_simple_lane_status_payload",
    "_build_source_serving_repair_receipt_payload",
    "_build_tigerbeetle_ledger_status",
    "_build_torghut_routeability_admission_ref",
    "_build_torghut_stage_clearance_packet_ref",
    "_build_trading_consumer_evidence_payload",
    "_build_trading_proofs_payload",
    "_cache_completed_trading_health_surface_payload",
    "_cached_external_paper_route_target_plan_success",
    "_cached_readiness_dependencies_for_health_surface",
    "_cached_trading_health_surface_payload",
    "_check_account_scope_invariants_bounded",
    "_check_alpaca",
    "_check_clickhouse",
    "_check_postgres",
    "_check_tigerbeetle_protocol_health",
    "_consumer_evidence_dependency_quorum",
    "_consumer_evidence_jangar_continuity_packet",
    "_consumer_evidence_summary_view",
    "_core_readiness_live_submission_gate",
    "_daily_runtime_ledger_portfolio_summary",
    "_decimal_average",
    "_decimal_or_none",
    "_decimal_percentile",
    "_decimal_to_string",
    "_deferred_hypothesis_payload_for_live_submission_gate",
    "_empirical_jobs_status",
    "_empty_tigerbeetle_ref_counts",
    "_ensure_utc_datetime",
    "_env_csv",
    "_env_json_string_list",
    "_env_or_none",
    "_evaluate_core_readiness_payload",
    "_evaluate_database_contract",
    "_evaluate_scheduler_status",
    "_evaluate_trading_health_payload",
    "_evaluate_trading_health_payload_bounded",
    "_evaluate_universe_dependency",
    "_execute_readiness_account_scope_query",
    "_extract_bearer_token",
    "_extract_gate_result",
    "_fail_closed_health_evaluation_gate",
    "_fetch_paper_route_target_plan_url",
    "_finalize_tca_aggregates",
    "_forecast_service_status",
    "_guard_live_submission_gate_for_readiness",
    "_health_surface_timeout_dependency_placeholder",
    "_health_surface_timeout_fallback_payload",
    "_hypothesis_payload_read_model_unavailable",
    "_latest_reconciliation_ref_counts",
    "_lean_authority_status",
    "_load_bounded_options_catalog_freshness_summary",
    "_load_cached_options_catalog_freshness_summary",
    "_load_clickhouse_ta_status",
    "_load_external_paper_route_target_plan",
    "_load_jangar_dependency_quorum_payload",
    "_load_jangar_verify_trust_foreclosure_board",
    "_load_json_artifact_payload",
    "_load_last_decision_at",
    "_load_llm_evaluation",
    "_load_options_catalog_freshness_summary",
    "_load_rejected_signal_outcome_learning_summary",
    "_load_route_provenance_summary",
    "_load_runtime_profitability_decisions",
    "_load_runtime_profitability_executions",
    "_load_runtime_profitability_gate_rollback_attribution",
    "_load_runtime_profitability_realized_pnl_summary",
    "_load_tca_summary",
    "_load_trading_status_hypothesis_runtime",
    "_load_trading_status_llm_evaluation",
    "_load_trading_status_runtime_ledger_portfolio_summary",
    "_load_trading_status_tca_summary",
    "_load_trading_status_tigerbeetle_ledger",
    "_mapping_items",
    "_merge_external_paper_route_target_plan",
    "_minimal_health_surface_timeout_live_submission_gate",
    "_minimal_health_surface_timeout_payload",
    "_minimal_health_surface_timeout_proof_floor",
    "_new_tca_aggregate",
    "_normalized_adapter_name",
    "_normalized_paper_route_text",
    "_paper_route_mapping_targets_sim_account",
    "_paper_route_probe_book_from_target_plan",
    "_paper_route_probe_symbol_values_from_mapping",
    "_paper_route_probe_symbols_from_target_plan_strategies",
    "_paper_route_source_collection_target_cache_safe",
    "_paper_route_target_account_audit_available",
    "_paper_route_target_plan_audit_mode_value",
    "_paper_route_target_plan_cache_safe_for_live",
    "_paper_route_target_plan_from_payload",
    "_paper_route_target_plan_probe_notional",
    "_paper_route_target_plan_probe_symbols",
    "_paper_route_target_plan_success_cache",
    "_paper_route_target_plan_targets",
    "_paper_route_target_plan_truthy",
    "_paper_route_target_plan_url_points_to_self",
    "_paper_route_target_strategy_lookup_names",
    "_proof_kind_value",
    "_proof_window_value",
    "_readiness_authority_truthy",
    "_readiness_dependency_cache_key",
    "_readiness_dependency_checks",
    "_readiness_dependency_degradation_reason_codes",
    "_readiness_dependency_snapshot",
    "_record_trading_health_surface_completion",
    "_refresh_universe_state_for_readiness",
    "_register_whitepaper_inngest_routes",
    "_remember_alpaca_success",
    "_remember_external_paper_route_target_plan_success",
    "_require_whitepaper_control_token",
    "_resolve_active_capital_stage",
    "_resolve_tca_scope_symbols",
    "_resolve_universe_resolver_for_readiness",
    "_retryable_tca_recompute_error",
    "_revenue_repair_topline_fields",
    "_rollback_status_read_session",
    "_route_claim_symbols",
    "_route_continuity_packet_for_proof_floor",
    "_runtime_ledger_bucket_evidence_grade",
    "_safe_float",
    "_safe_int",
    "_shared_mapping_items",
    "_shared_paper_route_target_plan_from_payload",
    "_simple_lane_reject_reason_totals",
    "_simulation_cache_status_payload",
    "_sqlalchemy_error_indicates_statement_timeout",
    "_store_options_catalog_freshness_summary",
    "_strip_promotion_authority_claims_for_readiness",
    "_tca_as_float",
    "_tca_as_int",
    "_tca_row_payload",
    "_tigerbeetle_status_int",
    "_to_str_map",
    "_trading_health_surface_cache_key",
    "_trading_scheduler_for_proofs",
    "_unavailable_runtime_ledger_portfolio_summary",
    "_unavailable_tigerbeetle_reconciliation_payload",
    "_update_tca_aggregate",
    "trading_status",
)

app: Any
_ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS: Any
_ALPACA_HEALTH_CACHE_LOCK: Any
_ALPACA_HEALTH_STATE: Any
_OPTIONS_CATALOG_FRESHNESS_CACHE: Any
_OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK: Any
_PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL: Any
_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS: Any
_PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK: Any
_READINESS_PROMOTION_AUTHORITY_KEYS: Any
_RETRYABLE_TCA_RECOMPUTE_SQLSTATES: Any
_SIMPLE_LANE_ALLOWED_REJECT_REASONS: Any
_TRADING_DEPENDENCY_HEALTH_CACHE: Any
_TRADING_DEPENDENCY_HEALTH_CACHE_LOCK: Any
_TRADING_HEALTH_SURFACE_EVALUATIONS: Any
_TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR: Any
_TRADING_HEALTH_SURFACE_EVALUATION_LOCK: Any
_TRADING_HEALTH_SURFACE_PAYLOAD_CACHE: Any
_TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS: Any
_TRADING_STATUS_READ_BUDGET_SECONDS: Any
_TradingStatusReadBudget: Any
_ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS: Any
_active_runtime_revision: Any
_aggregate_tca_rows: Any
_alpaca_cached_last_good: Any
_alpaca_endpoint_class: Any
_alpaca_failure_status: Any
_alpaca_probe_account: Any
_append_unique_reason: Any
_apply_status_read_statement_timeout: Any
_assert_dspy_cutover_migration_guard: Any
_budget_exhausted_live_submission_gate_payload: Any
_budget_exhausted_options_catalog_freshness_payload: Any
_budget_unavailable_hypothesis_runtime_payload: Any
_budget_unavailable_llm_evaluation_payload: Any
_budget_unavailable_tca_summary_payload: Any
_budget_unavailable_tigerbeetle_ledger_payload: Any
_build_autonomy_bridge_status: Any
_build_autonomy_capital_replay_projection: Any
_build_capital_reentry_cohort_ledger_payload: Any
_build_capital_replay_projection_payload: Any
_build_clock_settlement_payload: Any
_build_consumer_evidence_receipt_projection: Any
_build_control_plane_contract: Any
_build_current_evidence_epoch: Any
_build_evidence_clock_payloads: Any
_build_freshness_carry_ledger_payload: Any
_build_hypothesis_runtime_payload: Any
_build_jangar_contract_graduation_ref: Any
_build_jangar_execution_trust_admission_ref: Any
_build_jangar_material_verdict_ref: Any
_build_jangar_reliability_settlement_ref: Any
_build_live_submission_gate_payload: Any
_build_persisted_vnext_status: Any
_build_profit_carry_passport_ledger_payload: Any
_build_profit_freshness_frontier_payload: Any
_build_profit_repair_settlement_ledger_payload: Any
_build_profit_signal_quorum_payload: Any
_build_profitability_proof_floor_payload: Any
_build_quality_adjusted_profit_frontier_payload: Any
_build_rejected_signal_outcome_learning_payload: Any
_build_renewal_bond_profit_escrow_payload: Any
_build_repair_bid_settlement_payload: Any
_build_repair_outcome_dividend_ledger_payload: Any
_build_repair_receipt_frontier_payload: Any
_build_route_evidence_clearinghouse_payload: Any
_build_route_image_proof_summary: Any
_build_route_reacquisition_board_payload: Any
_build_route_warrant_exchange_payload: Any
_build_routeability_repair_acceptance_ledger_payload: Any
_build_shadow_first_runtime_payload: Any
_build_shadow_first_toggle_parity: Any
_build_simple_lane_status_payload: Any
_build_source_serving_repair_receipt_payload: Any
_build_tigerbeetle_ledger_status: Any
_build_torghut_routeability_admission_ref: Any
_build_torghut_stage_clearance_packet_ref: Any
_build_trading_consumer_evidence_payload: Any
_build_trading_proofs_payload: Any
_cache_completed_trading_health_surface_payload: Any
_cached_external_paper_route_target_plan_success: Any
_cached_readiness_dependencies_for_health_surface: Any
_cached_trading_health_surface_payload: Any
_check_account_scope_invariants_bounded: Any
_check_alpaca: Any
_check_clickhouse: Any
_check_postgres: Any
_check_tigerbeetle_protocol_health: Any
_consumer_evidence_dependency_quorum: Any
_consumer_evidence_jangar_continuity_packet: Any
_consumer_evidence_summary_view: Any
_core_readiness_live_submission_gate: Any
_daily_runtime_ledger_portfolio_summary: Any
_decimal_average: Any
_decimal_or_none: Any
_decimal_percentile: Any
_decimal_to_string: Any
_deferred_hypothesis_payload_for_live_submission_gate: Any
_empirical_jobs_status: Any
_empty_tigerbeetle_ref_counts: Any
_ensure_utc_datetime: Any
_env_csv: Any
_env_json_string_list: Any
_env_or_none: Any
_evaluate_core_readiness_payload: Any
_evaluate_database_contract: Any
_evaluate_scheduler_status: Any
_evaluate_trading_health_payload: Any
_evaluate_trading_health_payload_bounded: Any
_evaluate_universe_dependency: Any
_execute_readiness_account_scope_query: Any
_extract_bearer_token: Any
_extract_gate_result: Any
_fail_closed_health_evaluation_gate: Any
_fetch_paper_route_target_plan_url: Any
_finalize_tca_aggregates: Any
_forecast_service_status: Any
_guard_live_submission_gate_for_readiness: Any
_health_surface_timeout_dependency_placeholder: Any
_health_surface_timeout_fallback_payload: Any
_hypothesis_payload_read_model_unavailable: Any
_latest_reconciliation_ref_counts: Any
_lean_authority_status: Any
_load_bounded_options_catalog_freshness_summary: Any
_load_cached_options_catalog_freshness_summary: Any
_load_clickhouse_ta_status: Any
_load_external_paper_route_target_plan: Any
_load_jangar_dependency_quorum_payload: Any
_load_jangar_verify_trust_foreclosure_board: Any
_load_json_artifact_payload: Any
_load_last_decision_at: Any
_load_llm_evaluation: Any
_load_options_catalog_freshness_summary: Any
_load_rejected_signal_outcome_learning_summary: Any
_load_route_provenance_summary: Any
_load_runtime_profitability_decisions: Any
_load_runtime_profitability_executions: Any
_load_runtime_profitability_gate_rollback_attribution: Any
_load_runtime_profitability_realized_pnl_summary: Any
_load_tca_summary: Any
_load_trading_status_hypothesis_runtime: Any
_load_trading_status_llm_evaluation: Any
_load_trading_status_runtime_ledger_portfolio_summary: Any
_load_trading_status_tca_summary: Any
_load_trading_status_tigerbeetle_ledger: Any
_mapping_items: Any
_merge_external_paper_route_target_plan: Any
_minimal_health_surface_timeout_live_submission_gate: Any
_minimal_health_surface_timeout_payload: Any
_minimal_health_surface_timeout_proof_floor: Any
_new_tca_aggregate: Any
_normalized_adapter_name: Any
_normalized_paper_route_text: Any
_paper_route_mapping_targets_sim_account: Any
_paper_route_probe_book_from_target_plan: Any
_paper_route_probe_symbol_values_from_mapping: Any
_paper_route_probe_symbols_from_target_plan_strategies: Any
_paper_route_source_collection_target_cache_safe: Any
_paper_route_target_account_audit_available: Any
_paper_route_target_plan_audit_mode_value: Any
_paper_route_target_plan_cache_safe_for_live: Any
_paper_route_target_plan_from_payload: Any
_paper_route_target_plan_probe_notional: Any
_paper_route_target_plan_probe_symbols: Any
_paper_route_target_plan_success_cache: Any
_paper_route_target_plan_targets: Any
_paper_route_target_plan_truthy: Any
_paper_route_target_plan_url_points_to_self: Any
_paper_route_target_strategy_lookup_names: Any
_proof_kind_value: Any
_proof_window_value: Any
_readiness_authority_truthy: Any
_readiness_dependency_cache_key: Any
_readiness_dependency_checks: Any
_readiness_dependency_degradation_reason_codes: Any
_readiness_dependency_snapshot: Any
_record_trading_health_surface_completion: Any
_refresh_universe_state_for_readiness: Any
_register_whitepaper_inngest_routes: Any
_remember_alpaca_success: Any
_remember_external_paper_route_target_plan_success: Any
_require_whitepaper_control_token: Any
_resolve_active_capital_stage: Any
_resolve_tca_scope_symbols: Any
_resolve_universe_resolver_for_readiness: Any
_retryable_tca_recompute_error: Any
_revenue_repair_topline_fields: Any
_rollback_status_read_session: Any
_route_claim_symbols: Any
_route_continuity_packet_for_proof_floor: Any
_runtime_ledger_bucket_evidence_grade: Any
_safe_float: Any
_safe_int: Any
_shared_mapping_items: Any
_shared_paper_route_target_plan_from_payload: Any
_simple_lane_reject_reason_totals: Any
_simulation_cache_status_payload: Any
_sqlalchemy_error_indicates_statement_timeout: Any
_store_options_catalog_freshness_summary: Any
_strip_promotion_authority_claims_for_readiness: Any
_tca_as_float: Any
_tca_as_int: Any
_tca_row_payload: Any
_tigerbeetle_status_int: Any
_to_str_map: Any
_trading_health_surface_cache_key: Any
_trading_scheduler_for_proofs: Any
_unavailable_runtime_ledger_portfolio_summary: Any
_unavailable_tigerbeetle_reconciliation_payload: Any
_update_tca_aggregate: Any

def trading_status() -> dict[str, object]: ...
