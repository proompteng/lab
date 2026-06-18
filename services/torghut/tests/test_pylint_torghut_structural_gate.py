from __future__ import annotations

import sys

from scripts.run_pylint_torghut_structural_gate import (
    DEFAULT_PATHS,
    STRICT_STRUCTURAL_RULES,
    build_pylint_command,
)


def test_structural_gate_scans_full_torghut_surface_by_default() -> None:
    assert DEFAULT_PATHS == ("app", "scripts", "tests", "migrations")


def test_structural_gate_includes_final_hardening_rules() -> None:
    expected_rules = {
        "torghut-generated-split-filename",
        "torghut-dynamic-globals-reexport",
        "torghut-compat-module-wrapper",
        "torghut-compat-module-registry",
        "torghut-module-class-mutation",
        "torghut-module-replacement",
        "torghut-private-pyright-suppression",
        "torghut-file-pyright-suppression",
        "torghut-type-ignore",
        "torghut-file-ruff-noqa",
        "torghut-wildcard-ruff-noqa",
        "torghut-blanket-pylint-disable",
        "torghut-dynamic-attribute-hook",
        "torghut-dynamic-all",
        "torghut-wildcard-import",
        "torghut-custom-module-class",
        "torghut-test-compat-wrapper",
        "torghut-source-string-execution",
    }

    assert expected_rules <= set(STRICT_STRUCTURAL_RULES)


def test_structural_gate_builds_plugin_pylint_command() -> None:
    command = build_pylint_command(
        "torghut-wildcard-import,torghut-source-string-execution",
        "scripts.pylint_torghut_quality",
        ["app", "scripts"],
    )

    assert command == [
        sys.executable,
        "-m",
        "pylint",
        "--load-plugins=scripts.pylint_torghut_quality",
        "--disable=all",
        "--enable=torghut-wildcard-import,torghut-source-string-execution",
        "--score=n",
        "app",
        "scripts",
    ]
