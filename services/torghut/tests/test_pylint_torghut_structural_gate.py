from __future__ import annotations

import subprocess
import sys
from collections.abc import Sequence

import pytest

from scripts import run_pylint_torghut_structural_gate
from scripts.run_pylint_torghut_structural_gate import (
    DEFAULT_PATHS,
    STRICT_STRUCTURAL_RULES,
    build_pylint_command,
    main,
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
        "torghut-empty-all",
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


def test_structural_gate_skips_when_no_paths_exist(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        run_pylint_torghut_structural_gate, "_existing_paths", lambda paths: []
    )

    assert main(["--paths", "missing"]) == 0
    assert (
        capsys.readouterr().out
        == "No Torghut Python paths exist for structural gate.\n"
    )


def test_structural_gate_prints_success_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    observed_commands: list[list[str]] = []
    monkeypatch.setattr(
        run_pylint_torghut_structural_gate, "_existing_paths", lambda paths: ["app"]
    )

    def fake_run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
        observed_commands.append(list(command))
        return subprocess.CompletedProcess(
            args=list(command), returncode=0, stdout="pylint clean\n"
        )

    monkeypatch.setattr(run_pylint_torghut_structural_gate, "_run", fake_run)

    assert (
        main(
            [
                "--paths",
                "app",
                "--enable",
                "torghut-wildcard-import",
                "--load-plugins",
                "",
            ]
        )
        == 0
    )

    assert observed_commands == [
        [
            sys.executable,
            "-m",
            "pylint",
            "--disable=all",
            "--enable=torghut-wildcard-import",
            "--score=n",
            "app",
        ]
    ]
    assert (
        capsys.readouterr().out
        == "pylint clean\nNo Torghut structural Pylint violations.\n"
    )


def test_structural_gate_returns_pylint_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        run_pylint_torghut_structural_gate, "_existing_paths", lambda paths: ["scripts"]
    )

    def fake_run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=list(command), returncode=12, stdout="structural violation\n"
        )

    monkeypatch.setattr(run_pylint_torghut_structural_gate, "_run", fake_run)

    assert main(["--paths", "scripts"]) == 12
    assert capsys.readouterr().out == "structural violation\n"
