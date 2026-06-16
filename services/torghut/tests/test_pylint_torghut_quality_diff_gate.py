from __future__ import annotations

from pathlib import Path

import scripts.run_pylint_torghut_quality_diff_gate as diff_gate
from scripts.run_pylint_torghut_quality_diff_gate import (
    PylintMessage,
    filter_messages,
    parse_changed_lines,
    parse_pylint_messages,
)


def test_parse_changed_lines_tracks_new_hunk_lines() -> None:
    diff_text = "\n".join(
        (
            "diff --git a/services/torghut/app/example.py b/services/torghut/app/example.py",
            "+++ b/services/torghut/app/example.py",
            "@@ -4,0 +5,2 @@",
            "+from app.other import specific_name",
            "+value = specific_name()",
            "@@ -12,2 +14,3 @@",
            " context",
            "+new_value = 1",
        )
    )

    changed_lines = parse_changed_lines(diff_text)

    assert changed_lines == {"app/example.py": {5, 6, 14, 15, 16}}


def test_filter_messages_keeps_only_changed_line_violations() -> None:
    changed_lines = {"app/example.py": {12}}
    messages = [
        PylintMessage(
            path="app/example.py",
            line=1,
            raw="app/example.py:1:0: C9009: existing noqa",
        ),
        PylintMessage(
            path="app/example.py",
            line=12,
            raw="app/example.py:12:0: C9013: new wildcard",
        ),
    ]

    assert filter_messages(messages, changed_lines) == [messages[1]]


def test_parse_pylint_messages_ignores_module_headers() -> None:
    output = "\n".join(
        (
            "************* Module app.example",
            "app/example.py:12:0: C9013: Wildcard import from app.other (torghut-wildcard-import)",
        )
    )

    assert parse_pylint_messages(output) == [
        PylintMessage(
            path="app/example.py",
            line=12,
            raw="app/example.py:12:0: C9013: Wildcard import from app.other (torghut-wildcard-import)",
        )
    ]


def test_filter_base_line_messages_skips_existing_base_source(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "app" / "example.py"
    source.parent.mkdir()
    source.write_text(
        "def moved_legacy_helper() -> None:\n    pass\ndef new_helper() -> None:\n",
        encoding="utf-8",
    )
    moved_message = PylintMessage(
        path="app/example.py",
        line=1,
        raw="app/example.py:1:0: R0915: Too many statements (too-many-statements)",
    )
    new_message = PylintMessage(
        path="app/example.py",
        line=3,
        raw="app/example.py:3:0: R0915: Too many statements (too-many-statements)",
    )
    monkeypatch.setattr(
        diff_gate,
        "_base_torghut_app_script_lines",
        lambda base, repo_root: {"def moved_legacy_helper() -> None:"},
    )

    assert diff_gate.filter_base_line_messages(
        [moved_message, new_message],
        base="base",
        current_root=tmp_path,
        repo_root=tmp_path,
    ) == [new_message]
