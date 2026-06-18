from __future__ import annotations

from importlib import import_module


def test_trading_pipeline_split_packages_are_importable() -> None:
    modules = [
        "tests.pipeline.test_trading_pipeline_quote_outcome",
        "tests.pipeline.test_trading_pipeline_warmup_submission_a",
        "tests.pipeline.test_trading_pipeline_warmup_submission_b",
        "tests.pipeline.test_trading_pipeline_paper_route_quote_a",
        "tests.pipeline.test_trading_pipeline_paper_route_quote_b",
        "tests.pipeline.test_trading_pipeline_retry_profit_floor_a",
        "tests.pipeline.test_trading_pipeline_retry_profit_floor_b",
        "tests.pipeline.test_trading_pipeline_probe_exits_a",
        "tests.pipeline.test_trading_pipeline_probe_exits_b",
        "tests.pipeline.test_trading_pipeline_materialized_target_plan_a",
        "tests.pipeline.test_trading_pipeline_materialized_target_plan_b",
        "tests.pipeline.test_trading_pipeline_materialized_target_plan_c",
        "tests.pipeline.test_trading_pipeline_target_plan_source_a",
        "tests.pipeline.test_trading_pipeline_target_plan_source_b",
        "tests.pipeline.test_trading_pipeline_target_plan_source_c",
        "tests.pipeline.test_trading_pipeline_external_targets_a",
        "tests.pipeline.test_trading_pipeline_external_targets_b",
        "tests.pipeline.test_trading_pipeline_external_targets_c",
        "tests.pipeline.test_trading_pipeline_external_targets_d",
        "tests.pipeline.test_trading_pipeline_route_execution_a",
        "tests.pipeline.test_trading_pipeline_route_execution_b",
        "tests.pipeline.test_trading_pipeline_live_regime_a",
        "tests.pipeline.test_trading_pipeline_live_regime_b",
        "tests.pipeline.test_trading_pipeline_live_regime_c",
        "tests.pipeline.test_trading_pipeline_runtime_uncertainty_a",
        "tests.pipeline.test_trading_pipeline_runtime_uncertainty_b",
        "tests.pipeline.test_trading_pipeline_position_projection_a",
        "tests.pipeline.test_trading_pipeline_position_projection_b",
        "tests.pipeline.test_trading_pipeline_execution_llm_a",
        "tests.pipeline.test_trading_pipeline_execution_llm_b",
        "tests.pipeline.test_trading_pipeline_dspy_gate_a",
        "tests.pipeline.test_trading_pipeline_dspy_gate_b",
        "tests.pipeline.test_trading_pipeline_dspy_gate_c",
        "tests.pipeline.test_trading_pipeline_dspy_gate_d",
        "tests.pipeline.test_trading_pipeline_stage_llm",
    ]
    for module_name in modules:
        import_module(module_name)
