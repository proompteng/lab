from __future__ import annotations

import importlib
from pathlib import Path
import sys
import types

import pytest


EXPLICIT_IMPORT_SURFACES = (
    "app.config",
    "app.metrics",
    "app.api.health_checks",
    "app.api.proof_floor_payloads",
    "app.api.readiness_helpers",
    "app.api.trading_misc",
    "app.models.entities",
    "app.trading.alpha.lane",
    "app.trading.autonomy.gates",
    "app.trading.autonomy.policy_check",
    "app.trading.completion",
    "app.trading.decisions",
    "app.trading.discovery.autoresearch",
    "app.trading.discovery.evidence_bundles",
    "app.trading.discovery.fast_replay",
    "app.trading.discovery.microstructure_prefilter",
    "app.trading.discovery.microstructure_regime_tokenization_stress",
    "app.trading.discovery.mlx_training_data",
    "app.trading.discovery.portfolio_optimizer",
    "app.trading.discovery.profit_target_oracle",
    "app.trading.discovery.queue_survival_fill_stress",
    "app.trading.discovery.replay_ledger_ranker",
    "app.trading.discovery.replay_tape",
    "app.trading.discovery.runtime_closure",
    "app.trading.evaluation",
    "app.trading.executable_alpha_receipts",
    "app.trading.execution_adapters",
    "app.trading.execution",
    "app.trading.execution_policy",
    "app.trading.hypotheses",
    "app.trading.ingest",
    "app.trading.intraday_tsmom_contract",
    "app.trading.llm.dspy_compile.workflow",
    "app.trading.order_feed",
    "app.trading.paper_route_target_plan",
    "app.trading.portfolio",
    "app.trading.profit_freshness_frontier",
    "app.trading.profitability_archive",
    "app.trading.proof_floor",
    "app.trading.reporting",
    "app.trading.revenue_repair",
    "app.trading.research_sleeves",
    "app.trading.research_sleeve_evaluators",
    "app.trading.runtime_authority_verifier",
    "app.trading.runtime_ledger",
    "app.trading.runtime_window_import",
    "app.trading.scheduler.governance",
    "app.trading.scheduler.paper_route_probe",
    "app.trading.scheduler.pipeline",
    "app.trading.scheduler.source_collection",
    "app.trading.scheduler.state",
    "app.trading.scheduler.submission_preparation",
    "app.trading.scheduler.target_plan_helpers",
    "app.trading.session_context",
    "app.trading.strategy_runtime",
    "app.trading.submission_council",
    "app.trading.tca",
    "app.trading.tigerbeetle_journal",
    "app.trading.tigerbeetle_reconcile",
    "app.whitepapers.claim_compiler",
    "app.whitepapers.workflow",
    "scripts.analyze_historical_simulation",
    "scripts.historical_simulation_analysis",
    "scripts.assemble_runtime_ledger_proof_packet",
    "scripts.runtime_ledger_proof_packet",
    "scripts.audit_hpairs_signal_liveness",
    "scripts.hpairs_signal_liveness_audit",
    "scripts.audit_hpairs_source_proof_census",
    "scripts.hpairs_source_proof_census_audit",
    "scripts.build_historical_profitability_proof",
    "scripts.historical_profitability_proof",
    "scripts.flatten_paper_account_positions",
    "scripts.paper_account_position_flattening",
    "scripts.historical_simulation_verification",
    "scripts.historical_simulation_runtime_verification",
    "scripts.journal_tigerbeetle_order_events",
    "scripts.tigerbeetle_order_journal",
    "scripts.local_intraday_tsmom_replay",
    "scripts.intraday_tsmom_replay",
    "scripts.materialize_bounded_paper_route_targets",
    "scripts.paper_route_target_materialization",
    "scripts.readback_hpairs_profit_proof_gap",
    "scripts.hpairs_profit_proof_gap_readback",
    "scripts.renew_latest_empirical_promotion_jobs",
    "scripts.empirical_promotion_renewal",
    "scripts.run_local_simple_lane_replay",
    "scripts.simple_lane_replay",
    "scripts.run_strategy_autoresearch_loop",
    "scripts.strategy_autoresearch_loop",
    "scripts.start_historical_simulation",
    "scripts.historical_simulation_startup",
    "scripts.ta_replay_runner",
    "scripts.technical_analysis_replay",
    "scripts.verify_trading_readiness",
    "scripts.trading_readiness_verification",
)

COMPAT_MODULE_CLASS_ATTR = "__" + "CompatModule__"


@pytest.mark.parametrize("module_name", EXPLICIT_IMPORT_SURFACES)
def test_refactored_import_surfaces_are_normal_modules(module_name: str) -> None:
    module = importlib.import_module(module_name)

    assert module.__name__ == module_name
    assert sys.modules[module_name] is module
    assert type(module) is types.ModuleType
    assert not hasattr(module, "__compat_module_segments__")
    assert not hasattr(module, COMPAT_MODULE_CLASS_ATTR)


def test_app_and_script_import_surfaces_do_not_ship_compatibility_stubs() -> None:
    service_root = Path(__file__).resolve().parents[1]
    stub_paths = sorted(
        str(path.relative_to(service_root))
        for tree_name in ("app", "scripts")
        for path in (service_root / tree_name).rglob("*.pyi")
    )

    assert stub_paths == []


@pytest.mark.parametrize(
    "module_name",
    (
        "app.config_modules",
        "app.metrics_modules",
        "app.api.health_checks_modules",
        "app.api.proof_floor_payloads_modules",
        "app.api.readiness_helpers_modules",
        "app.api.trading_misc_modules",
        "app.models.entities_modules",
        "app.trading.alpha.lane_modules",
        "app.trading.autonomy.gates_modules",
        "app.trading.autonomy.policy_check_modules",
        "app.trading.completion_modules",
        "app.trading.decisions_modules",
        "app.trading.discovery.autoresearch_modules",
        "app.trading.discovery.evidence_bundles_modules",
        "app.trading.discovery.fast_replay_modules",
        "app.trading.discovery.microstructure_prefilter_modules",
        "app.trading.discovery.microstructure_regime_tokenization_stress_modules",
        "app.trading.discovery.mlx_training_data_modules",
        "app.trading.discovery.portfolio_optimizer_modules",
        "app.trading.discovery.profit_target_oracle_modules",
        "app.trading.discovery.queue_survival_fill_stress_modules",
        "app.trading.discovery.replay_ledger_ranker_modules",
        "app.trading.discovery.replay_tape_modules",
        "app.trading.discovery.runtime_closure_modules",
        "app.trading.evaluation_modules",
        "app.trading.executable_alpha_receipts_modules",
        "app.trading.execution_adapters_modules",
        "app.trading.execution_modules",
        "app.trading.execution_policy_modules",
        "app.trading.hypotheses_modules",
        "app.trading.ingest_modules",
        "app.trading.intraday_tsmom_contract_modules",
        "app.trading.llm.dspy_compile.workflow_modules",
        "app.trading.order_feed_modules",
        "app.trading.paper_route_target_plan_modules",
        "app.trading.portfolio_modules",
        "app.trading.profit_freshness_frontier_modules",
        "app.trading.profitability_archive_modules",
        "app.trading.proof_floor_modules",
        "app.trading.reporting_modules",
        "app.trading.revenue_repair_modules",
        "app.trading.runtime_authority_verifier_modules",
        "app.trading.runtime_ledger_modules",
        "app.trading.runtime_window_import_modules",
        "app.trading.scheduler.governance_modules",
        "app.trading.scheduler.paper_route_probe_modules",
        "app.trading.scheduler.pipeline_modules",
        "app.trading.scheduler.source_collection_modules",
        "app.trading.scheduler.state_modules",
        "app.trading.scheduler.submission_preparation_modules",
        "app.trading.scheduler.target_plan_helpers_modules",
        "app.trading.session_context_modules",
        "app.trading.strategy_runtime_modules",
        "app.trading.submission_council_modules",
        "app.trading.tca_modules",
        "app.trading.tigerbeetle_journal_modules",
        "app.trading.tigerbeetle_reconcile_modules",
        "app.whitepapers.claim_compiler_modules",
        "app.whitepapers.workflow_modules",
    ),
)
def test_removed_app_module_split_packages_are_not_importable(
    module_name: str,
) -> None:
    importlib.invalidate_caches()
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(module_name)


@pytest.mark.parametrize(
    "module_name",
    (
        "scripts.analyze_historical_simulation_modules",
        "scripts.assemble_runtime_ledger_proof_packet_modules",
        "scripts.audit_hpairs_signal_liveness_modules",
        "scripts.audit_hpairs_source_proof_census_modules",
        "scripts.build_historical_profitability_proof_modules",
        "scripts.flatten_paper_account_positions_modules",
        "scripts.historical_simulation_verification_modules",
        "scripts.journal_tigerbeetle_order_events_modules",
        "scripts.local_intraday_tsmom_replay_modules",
        "scripts.materialize_bounded_paper_route_targets_modules",
        "scripts.readback_hpairs_profit_proof_gap_modules",
        "scripts.renew_latest_empirical_promotion_jobs_modules",
        "scripts.run_local_simple_lane_replay_modules",
        "scripts.run_strategy_autoresearch_loop_modules",
        "scripts.start_historical_simulation_modules",
        "scripts.ta_replay_runner_modules",
        "scripts.verify_trading_readiness_modules",
    ),
)
def test_removed_script_module_split_packages_are_not_importable(
    module_name: str,
) -> None:
    importlib.invalidate_caches()
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(module_name)
