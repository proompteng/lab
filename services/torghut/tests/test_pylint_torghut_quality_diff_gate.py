from __future__ import annotations

from pathlib import Path

import scripts.run_pylint_torghut_quality_diff_gate as diff_gate
from scripts.run_pylint_torghut_quality_diff_gate import (
    AllowlistEntry,
    CUSTOM_RULES,
    PylintMessage,
    filter_allowlisted_messages,
    filter_messages,
    load_allowlist,
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


def test_default_diff_gate_rules_include_cleanup_guard_rules() -> None:
    assert "torghut-test-compat-wrapper" in CUSTOM_RULES
    assert "torghut-private-pyright-suppression" in CUSTOM_RULES
    assert "torghut-wildcard-ruff-noqa" in CUSTOM_RULES
    assert "torghut-source-string-execution" in CUSTOM_RULES
    assert "torghut-typing-any-import" in CUSTOM_RULES
    assert "torghut-broad-exception" in CUSTOM_RULES
    assert "torghut-base-exception" in CUSTOM_RULES


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
            symbol="torghut-wildcard-import",
        )
    ]


def test_filter_allowlisted_messages_requires_path_and_symbol_match() -> None:
    allowlist = [
        AllowlistEntry(
            path="app/example.py",
            symbol="torghut-broad-exception",
            owner="runtime",
            reason="fail closed dependency boundary",
            removal_target="replace with domain exception",
        )
    ]
    allowed = PylintMessage(
        path="app/example.py",
        line=12,
        raw="app/example.py:12:0: C9022: Broad except Exception (torghut-broad-exception)",
        symbol="torghut-broad-exception",
    )
    blocked = PylintMessage(
        path="app/example.py",
        line=13,
        raw="app/example.py:13:0: C9023: BaseException (torghut-base-exception)",
        symbol="torghut-base-exception",
    )

    assert filter_allowlisted_messages([allowed, blocked], allowlist) == [blocked]


def test_load_allowlist_requires_review_metadata(tmp_path: Path) -> None:
    allowlist = tmp_path / "allowlist.toml"
    allowlist.write_text(
        "\n".join(
            (
                "[[allow]]",
                'path = "app/example.py"',
                'symbol = "torghut-broad-exception"',
                'owner = "runtime"',
                'reason = "fail closed dependency boundary"',
                'removal_target = "replace with domain exception"',
            )
        ),
        encoding="utf-8",
    )

    assert load_allowlist(allowlist) == [
        AllowlistEntry(
            path="app/example.py",
            symbol="torghut-broad-exception",
            owner="runtime",
            reason="fail closed dependency boundary",
            removal_target="replace with domain exception",
        )
    ]


def test_load_allowlist_rejects_unowned_exception(tmp_path: Path) -> None:
    allowlist = tmp_path / "allowlist.toml"
    allowlist.write_text(
        "\n".join(
            (
                "[[allow]]",
                'path = "app/example.py"',
                'symbol = "torghut-broad-exception"',
                'reason = "missing owner"',
                'removal_target = "replace with domain exception"',
            )
        ),
        encoding="utf-8",
    )

    try:
        load_allowlist(allowlist)
    except ValueError as exc:
        assert "owner" in str(exc)
    else:
        raise AssertionError("allowlist entry without owner should fail")


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


def test_filter_base_line_messages_treats_private_definition_rename_as_existing(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "app" / "example.py"
    source.parent.mkdir()
    source.write_text(
        "def renamed_helper() -> None:\n"
        "    pass\n"
        "async def renamed_async_helper() -> None:\n"
        "    pass\n"
        "class RenamedService:\n",
        encoding="utf-8",
    )
    messages = [
        PylintMessage(
            path="app/example.py",
            line=1,
            raw="app/example.py:1:0: R0915: Too many statements (too-many-statements)",
        ),
        PylintMessage(
            path="app/example.py",
            line=3,
            raw="app/example.py:3:0: R0915: Too many statements (too-many-statements)",
        ),
        PylintMessage(
            path="app/example.py",
            line=5,
            raw="app/example.py:5:0: R0902: Too many instance attributes (too-many-instance-attributes)",
        ),
    ]
    base_lines = diff_gate._source_line_equivalents(
        (
            "def _renamed_helper() -> None:",
            "async def _renamed_async_helper() -> None:",
            "class _RenamedService:",
        )
    )
    monkeypatch.setattr(
        diff_gate,
        "_base_torghut_app_script_lines",
        lambda base, repo_root: base_lines,
    )

    assert (
        diff_gate.filter_base_line_messages(
            messages,
            base="base",
            current_root=tmp_path,
            repo_root=tmp_path,
        )
        == []
    )
