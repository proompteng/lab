from __future__ import annotations

from importlib import import_module


def test_search_consistent_profitability_frontier_split_packages_are_importable() -> (
    None
):
    modules = [
        "tests.profitability_frontier.test_search_frontier_ledger_args",
        "tests.profitability_frontier.test_search_frontier_consistency_a",
        "tests.profitability_frontier.test_search_frontier_run_ablation",
        "tests.profitability_frontier.test_search_frontier_replay_inputs",
        "tests.profitability_frontier.test_search_frontier_shortlist",
        "tests.profitability_frontier.test_search_frontier_repair_children",
        "tests.profitability_frontier.test_search_frontier_consistency_b",
        "tests.profitability_frontier.test_search_frontier_main_a",
        "tests.profitability_frontier.test_search_frontier_staged",
        "tests.profitability_frontier.test_search_frontier_main_b",
    ]
    for module_name in modules:
        import_module(module_name)
