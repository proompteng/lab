from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import pytest

from scripts import check_refactor_quality as guard


def test_refactor_quality_violation_render_formats_paths() -> None:
    assert (
        guard.Violation("app/example.py", 0, "bad pattern", "detail").render()
        == "app/example.py: bad pattern: detail"
    )
    assert (
        guard.Violation("app/example.py", 17, "bad pattern", "detail").render()
        == "app/example.py:17: bad pattern: detail"
    )


def test_refactor_quality_guard_resolves_repo_root(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    nested = repo / "services" / "torghut"
    nested.mkdir(parents=True)

    assert guard._repo_root(nested) == repo

    with pytest.raises(RuntimeError, match="repo_root_not_found"):
        guard._repo_root(tmp_path / "missing")


def test_refactor_quality_guard_resolves_base_spec(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GITHUB_BASE_REF", raising=False)
    assert guard._resolve_base_spec("") is None

    monkeypatch.setenv("GITHUB_BASE_REF", "main")
    assert guard._resolve_base_spec("") == "origin/main"
    assert guard._resolve_base_spec(" upstream/main ") == "upstream/main"


def test_refactor_quality_guard_resolves_diff_base_with_fallbacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: list[tuple[str, ...]] = []

    def fake_git_optional(_cwd: Path, *args: str) -> str | None:
        attempts.append(args)
        if args == ("merge-base", "main", "HEAD"):
            return "fallback-sha"
        return None

    monkeypatch.setattr(guard, "_git_optional", fake_git_optional)

    assert guard._resolve_diff_base(Path("/repo"), "") == "fallback-sha"
    assert ("merge-base", "origin/main", "HEAD") in attempts
    assert ("merge-base", "main", "HEAD") in attempts


def test_refactor_quality_guard_git_optional_returns_none_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_git(_cwd: Path, *args: str) -> str:
        raise subprocess.CalledProcessError(1, ["git", *args])

    monkeypatch.setattr(guard, "_git", fail_git)

    assert guard._git_optional(Path("/repo"), "merge-base", "main", "HEAD") is None


def test_refactor_quality_guard_collects_changed_python_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_git(_cwd: Path, *args: str) -> str:
        assert args[:3] == ("diff", "--name-only", "--diff-filter=ACMR")
        return "\n".join(
            (
                "services/torghut/app/runtime.py",
                "services/torghut/scripts/proof.py",
                "services/torghut/README.md",
                "services/other/app.py",
            )
        )

    def fake_git_optional(_cwd: Path, *args: str) -> str | None:
        if args == ("diff", "--name-only", "--diff-filter=ACMR", "HEAD"):
            return "services/torghut/tests/test_runtime.py"
        if args == ("diff", "--cached", "--name-only", "--diff-filter=ACMR", "HEAD"):
            return "services/torghut/migrations/env.py"
        if args[:3] == ("ls-files", "--others", "--exclude-standard"):
            return "services/torghut/app/untracked.py\nignored.txt"
        return None

    monkeypatch.setattr(guard, "_resolve_diff_base", lambda _repo, _base_ref: "base")
    monkeypatch.setattr(guard, "_git", fake_git)
    monkeypatch.setattr(guard, "_git_optional", fake_git_optional)

    assert guard._changed_python_files(Path("/repo"), "") == (
        "app/runtime.py",
        "app/untracked.py",
        "migrations/env.py",
        "scripts/proof.py",
        "tests/test_runtime.py",
    )


def test_refactor_quality_guard_lists_all_python_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        guard,
        "_git",
        lambda _cwd, *args: "\n".join(
            (
                "services/torghut/app/runtime.py",
                "services/torghut/scripts/proof.pyi",
                "services/torghut/tests/readme.txt",
            )
        ),
    )

    assert guard._all_python_files(Path("/repo")) == (
        "app/runtime.py",
        "scripts/proof.pyi",
    )


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


def test_refactor_quality_guard_rejects_module_type_classes() -> None:
    bad_text = "\n".join(
        (
            "from types import ModuleType",
            "class Facade(ModuleType):",
            "    pass",
        )
    )

    assert [
        violation.reason
        for violation in guard._ast_violations("app/example.py", bad_text)
    ] == ["custom module class"]


def test_refactor_quality_guard_main_reports_success_and_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    service_root = tmp_path / "services" / "torghut"
    app_file = service_root / "app" / "runtime.py"
    app_file.parent.mkdir(parents=True)
    app_file.write_text("answer = 1\n", encoding="utf-8")
    monkeypatch.setattr(
        guard,
        "_parse_args",
        lambda: argparse.Namespace(all=False, base_ref=""),
    )
    monkeypatch.setattr(guard, "_repo_root", lambda _start: tmp_path)
    monkeypatch.setattr(
        guard, "_changed_python_files", lambda _repo, _base: ("app/runtime.py",)
    )

    assert guard.main() == 0
    assert "passed for 1 Torghut Python file" in capsys.readouterr().out

    app_file.write_text("# pyright: reportUnknownMemberType=false\n", encoding="utf-8")

    assert guard.main() == 1
    output = capsys.readouterr().out
    assert "Torghut refactor quality guard failed" in output
    assert "file-level Pyright suppression" in output
