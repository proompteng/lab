from __future__ import annotations

import importlib
from pathlib import Path
import sys
import types

import pytest


EXPLICIT_FACADE_MODULES = (
    "app.trading.alpha.lane",
    "app.trading.alpha.lane_modules",
    "app.trading.autonomy.gates",
    "app.trading.autonomy.gates_modules",
    "app.trading.completion",
    "app.trading.completion_modules",
    "app.trading.decisions",
    "app.trading.decisions_modules",
    "app.trading.discovery.autoresearch",
    "app.trading.discovery.autoresearch_modules",
    "app.trading.discovery.evidence_bundles",
    "app.trading.discovery.evidence_bundles_modules",
    "app.trading.discovery.fast_replay",
    "app.trading.discovery.fast_replay_modules",
    "app.trading.discovery.microstructure_prefilter",
    "app.trading.discovery.microstructure_prefilter_modules",
    "app.trading.discovery.microstructure_regime_tokenization_stress",
    "app.trading.discovery.microstructure_regime_tokenization_stress_modules",
    "app.trading.discovery.mlx_training_data",
    "app.trading.discovery.mlx_training_data_modules",
    "app.trading.discovery.portfolio_optimizer",
    "app.trading.discovery.portfolio_optimizer_modules",
    "app.trading.discovery.queue_survival_fill_stress",
    "app.trading.discovery.queue_survival_fill_stress_modules",
    "app.trading.discovery.replay_ledger_ranker",
    "app.trading.discovery.replay_ledger_ranker_modules",
    "app.trading.discovery.replay_tape",
    "app.trading.discovery.replay_tape_modules",
    "app.trading.evaluation",
    "app.trading.evaluation_modules",
    "app.trading.executable_alpha_receipts",
    "app.trading.executable_alpha_receipts_modules",
    "app.trading.execution",
    "app.trading.execution_modules",
    "app.trading.hypotheses",
    "app.trading.hypotheses_modules",
    "app.trading.ingest",
    "app.trading.ingest_modules",
    "app.trading.intraday_tsmom_contract",
    "app.trading.intraday_tsmom_contract_modules",
    "app.trading.llm.dspy_compile.workflow",
    "app.trading.llm.dspy_compile.workflow_modules",
    "app.trading.order_feed_modules",
    "app.trading.profit_freshness_frontier",
    "app.trading.profit_freshness_frontier_modules",
    "app.trading.reporting",
    "app.trading.reporting_modules",
    "app.trading.research_sleeves",
    "app.trading.research_sleeves_modules",
    "app.trading.runtime_authority_verifier",
    "app.trading.runtime_authority_verifier_modules",
    "app.trading.runtime_ledger",
    "app.trading.runtime_ledger_modules",
    "app.trading.scheduler.governance",
    "app.trading.scheduler.governance_modules",
    "app.trading.strategy_runtime_modules",
    "app.trading.tigerbeetle_reconcile",
    "app.trading.tigerbeetle_reconcile_modules",
    "app.whitepapers.workflow",
    "app.whitepapers.workflow_modules",
    "scripts.audit_hpairs_source_proof_census",
    "scripts.audit_hpairs_source_proof_census_modules",
    "scripts.flatten_paper_account_positions",
    "scripts.flatten_paper_account_positions_modules",
    "scripts.renew_latest_empirical_promotion_jobs",
    "scripts.renew_latest_empirical_promotion_jobs_modules",
    "scripts.run_local_simple_lane_replay",
    "scripts.run_local_simple_lane_replay_modules",
    "scripts.run_strategy_autoresearch_loop",
    "scripts.run_strategy_autoresearch_loop_modules",
    "scripts.ta_replay_runner",
    "scripts.verify_trading_readiness",
    "scripts.verify_trading_readiness_modules",
)

COMPAT_MODULE_CLASS_ATTR = "__" + "CompatModule__"


@pytest.mark.parametrize("module_name", EXPLICIT_FACADE_MODULES)
def test_old_facade_imports_are_normal_modules(module_name: str) -> None:
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
