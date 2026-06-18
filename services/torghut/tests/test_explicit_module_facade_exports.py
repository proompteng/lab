from __future__ import annotations

import importlib
from pathlib import Path
import runpy
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
    "scripts.run_simulation_analysis",
    "scripts.run_strategy_autoresearch_loop",
    "scripts.strategy_autoresearch_loop",
    "scripts.historical_simulation_startup",
    "scripts.historical_simulation_startup.__main__",
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


def test_app_and_script_import_surfaces_do_not_ship_runtime_compat_modules() -> None:
    service_root = Path(__file__).resolve().parents[1]
    compat_module_paths = sorted(
        str(path.relative_to(service_root))
        for tree_name in ("app", "scripts")
        for path in (service_root / tree_name).rglob("*compat*.py")
    )

    assert compat_module_paths == []


def test_owner_modules_do_not_patch_through_public_wrappers() -> None:
    service_root = Path(__file__).resolve().parents[1]
    forbidden_by_path = {
        "scripts/runtime_ledger_proof_packet/io_artifacts.py": (
            "_public_wrapper_attr",
            "scripts.assemble_runtime_ledger_proof_packet",
        ),
        "scripts/hpairs_source_proof_census_audit/shared_context.py": (
            "_facade_attr",
            "scripts.audit_hpairs_source_proof_census",
        ),
        "app/trading/submission_council/common.py": (
            "_compat_symbol",
            "compat_symbol =",
            'sys.modules.get("app.trading.submission_council")',
        ),
        "app/trading/order_feed/repair_order_feed_execution_links.py": (
            "_order_feed_facade",
            "_facade_latest_order_event_for_execution",
            "_facade_apply_order_event_to_execution",
            "_facade_stable_execution_source_offset",
        ),
    }

    for relative_path, forbidden_tokens in forbidden_by_path.items():
        source = (service_root / relative_path).read_text(encoding="utf-8")
        for token in forbidden_tokens:
            assert token not in source, f"{relative_path} still contains {token}"


def test_app_and_script_modules_do_not_use_public_root_backchannels() -> None:
    service_root = Path(__file__).resolve().parents[1]
    offenders = sorted(
        str(path.relative_to(service_root))
        for tree_name in ("app", "scripts")
        for path in (service_root / tree_name).rglob("*.py")
        if "sys.modules.get(" in path.read_text(encoding="utf-8")
    )

    assert offenders == []


def test_app_and_script_modules_do_not_use_split_module_public_alias_blocks() -> None:
    service_root = Path(__file__).resolve().parents[1]
    marker = "Public aliases used by split modules"
    offenders = sorted(
        str(path.relative_to(service_root))
        for tree_name in ("app", "scripts")
        for path in (service_root / tree_name).rglob("*.py")
        if marker in path.read_text(encoding="utf-8")
    )

    assert offenders == []


def test_generated_split_package_directories_are_absent() -> None:
    service_root = Path(__file__).resolve().parents[1]
    split_package_suffix = "_" + "modules"
    generated_package_dirs = sorted(
        str(path.relative_to(service_root))
        for tree_name in ("app", "scripts")
        for path in (service_root / tree_name).rglob(f"*{split_package_suffix}")
        if path.is_dir()
    )

    assert generated_package_dirs == []


def test_flatten_package_does_not_patch_through_public_script_shim() -> None:
    service_root = Path(__file__).resolve().parents[1]
    flatten_package_root = (
        service_root / "scripts" / "paper_account_position_flattening"
    )
    public_shim_module = "scripts.flatten_paper_account_positions"
    shim_backchannel_paths = sorted(
        str(path.relative_to(service_root))
        for path in flatten_package_root.rglob("*.py")
        if public_shim_module in path.read_text()
    )

    assert shim_backchannel_paths == []


def test_historical_simulation_startup_module_entrypoint_exits_with_cli_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from scripts.historical_simulation_startup import cli

    monkeypatch.setattr(cli, "main", lambda: 23)
    sys.modules.pop("scripts.historical_simulation_startup.__main__", None)

    with pytest.raises(SystemExit) as exc_info:
        runpy.run_module(
            "scripts.historical_simulation_startup.__main__", run_name="__main__"
        )

    assert exc_info.value.code == 23
