from __future__ import annotations

from importlib import import_module


def test_policy_checks_split_packages_are_importable() -> None:
    modules = [
        "tests.policy_checks.test_policy_checks_manifest_a",
        "tests.policy_checks.test_policy_checks_manifest_b",
        "tests.policy_checks.test_policy_checks_manifest_c",
        "tests.policy_checks.test_policy_checks_runtime_evidence",
        "tests.policy_checks.test_policy_checks_benchmark_a",
        "tests.policy_checks.test_policy_checks_benchmark_b",
        "tests.policy_checks.test_policy_checks_advisor",
    ]
    for module in modules:
        import_module(module)
