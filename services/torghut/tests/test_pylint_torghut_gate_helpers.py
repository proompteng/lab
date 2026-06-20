from __future__ import annotations

import subprocess

from scripts import run_pylint_torghut_file_length_gate as file_length_gate
from scripts.run_pylint_torghut_file_length_gate import (
    _filter_file_length_messages,
)
from scripts.run_pylint_torghut_quality_diff_gate import _source_literal_lines


def test_source_literal_lines_decodes_generated_payload_lines() -> None:
    module_text = "SOURCE = 'def hidden() -> int:\\n    return 42\\n'"

    lines = _source_literal_lines(module_text)

    assert lines == {"def hidden() -> int:", "return 42"}


def test_file_length_filter_blocks_every_long_module() -> None:
    output = "\n".join(
        (
            "app/trading/autonomy/lane.py:1:0: C0302: Too many lines in module (8088/1000) (too-many-lines)",
            "app/trading/new_long_module.py:1:0: C0302: Too many lines in module (1200/1000) (too-many-lines)",
        )
    )

    messages = _filter_file_length_messages(
        output,
    )

    assert messages == [
        "app/trading/autonomy/lane.py:1:0: C0302: Too many lines in module (8088/1000) (too-many-lines)",
        "app/trading/new_long_module.py:1:0: C0302: Too many lines in module (1200/1000) (too-many-lines)",
    ]


def test_file_length_filter_no_longer_carries_transitional_baseline() -> None:
    output = "\n".join(
        (
            "scripts/run_whitepaper_autoresearch_profit_target.py:1:0: C0302: Too many lines in module (13541/1000) (too-many-lines)",
            "scripts/new_long_tool.py:1:0: C0302: Too many lines in module (1200/1000) (too-many-lines)",
        )
    )

    messages = _filter_file_length_messages(output)

    assert messages == [
        "scripts/run_whitepaper_autoresearch_profit_target.py:1:0: C0302: Too many lines in module (13541/1000) (too-many-lines)",
        "scripts/new_long_tool.py:1:0: C0302: Too many lines in module (1200/1000) (too-many-lines)",
    ]


def test_file_length_filter_ignores_static_explicit_all_declarations(tmp_path) -> None:
    module_path = tmp_path / "app" / "trading" / "exports.py"
    module_path.parent.mkdir(parents=True)
    module_path.write_text(
        "\n".join(
            (
                "value = 1",
                "",
                "__all__ = (",
                '    "value",',
                ")",
            )
        ),
        encoding="utf-8",
    )
    output = (
        "app/trading/exports.py:1:0: "
        "C0302: Too many lines in module (5/2) (too-many-lines)"
    )

    ignored_paths: set[str] = set()
    messages = _filter_file_length_messages(
        output,
        module_root=tmp_path,
        ignored_explicit_all_paths=ignored_paths,
    )

    assert messages == []
    assert ignored_paths == {"app/trading/exports.py"}


def test_file_length_filter_keeps_dynamic_all_declarations(tmp_path) -> None:
    module_path = tmp_path / "app" / "trading" / "dynamic_exports.py"
    module_path.parent.mkdir(parents=True)
    module_path.write_text(
        "\n".join(
            (
                "value = 1",
                "",
                "__all__ = [name for name in globals()]",
            )
        ),
        encoding="utf-8",
    )
    output = (
        "app/trading/dynamic_exports.py:1:0: "
        "C0302: Too many lines in module (3/2) (too-many-lines)"
    )

    messages = _filter_file_length_messages(
        output,
        module_root=tmp_path,
    )

    assert messages == [output]


def test_file_length_filter_ignores_non_length_pylint_messages() -> None:
    output = "app/trading/noisy.py:1:0: F0001: No module named app/trading/noisy.py"

    messages = _filter_file_length_messages(
        output,
    )

    assert messages == []


def test_file_length_main_blocks_legacy_extracted_source_debt(
    monkeypatch,
    capsys,
) -> None:
    def fake_run(command, *, check: bool, cwd=None):
        assert check is False
        assert cwd is None
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=(
                "scripts/run_whitepaper_autoresearch_profit_target.py:1:0: "
                "C0302: Too many lines in module (13541/1000) (too-many-lines)\n"
            ),
        )

    monkeypatch.setattr(file_length_gate, "_run", fake_run)

    result = file_length_gate.main(
        [
            "--base",
            "HEAD^",
            "scripts/run_whitepaper_autoresearch_profit_target.py",
        ]
    )

    assert result == 16
    assert "Pylint file-length violations:" in capsys.readouterr().out
