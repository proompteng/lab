from __future__ import annotations

from scripts import check_refactor_quality as guard


def test_refactor_quality_guard_rejects_generated_split_names() -> None:
    violations = guard._filename_violations(
        (
            "app/trading/foo_modules/part_01_statements.py",
            "scripts/bar_modules/source_part_02.py",
            "tests/foo/test_part_03.py",
            "app/trading/foo_modules/proof_artifacts.py",
        )
    )

    assert [violation.path for violation in violations] == [
        "app/trading/foo_modules/part_01_statements.py",
        "scripts/bar_modules/source_part_02.py",
        "tests/foo/test_part_03.py",
    ]


def test_refactor_quality_guard_rejects_dynamic_compatibility_facades() -> None:
    dynamic_reexport = "globals()" + ".update(other.__dict__)"
    bad_text = "\n".join(
        (
            "from __future__ import annotations",
            "def __getattr__(name: str):",
            "    raise AttributeError(name)",
            dynamic_reexport,
        )
    )

    violations = [
        *guard._text_violations("app/example.py", bad_text),
        *guard._ast_violations("app/example.py", bad_text),
    ]

    assert {violation.reason for violation in violations} == {
        "dynamic globals re-export",
        "module-level dynamic attribute hook",
    }


def test_refactor_quality_guard_rejects_blanket_suppressions_and_wildcards() -> None:
    type_suppression = "# type:" + " ignore[assignment]"
    bad_text = "\n".join(
        (
            "# pyright: reportUnknownMemberType=false",
            "# ruff: noqa: F401,F403",
            f"answer = 1  {type_suppression}",
            "from .proof import *",
        )
    )

    violations = [
        *guard._text_violations("app/example.py", bad_text),
        *guard._ast_violations("app/example.py", bad_text),
    ]

    assert {violation.reason for violation in violations} == {
        "file-level Pyright suppression",
        "file-level Ruff suppression",
        "type-check suppression",
        "wildcard import",
    }


def test_refactor_quality_guard_rejects_module_replacement_and_dynamic_all() -> None:
    module_replacement = "sys." + "modules[__name__] = impl"
    dynamic_exports = "__all__ = [name for name in " + "globals() if name]"
    bad_text = "\n".join(
        (
            "import sys",
            module_replacement,
            dynamic_exports,
        )
    )

    violations = [
        *guard._text_violations("app/example.py", bad_text),
        *guard._ast_violations("app/example.py", bad_text),
    ]

    assert {violation.reason for violation in violations} == {
        "dynamic __all__",
        "module replacement",
    }
