"""Run Torghut's file-length gate."""

from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

_PYLINT_MESSAGE_RE = re.compile(
    r"^(?P<path>[^:]+):(?P<line>\d+):(?P<column>\d+): "
    r"(?P<code>[A-Z]\d+): "
)
_PYLINT_FILE_LENGTH_RE = re.compile(
    r"Too many lines in module \((?P<actual>\d+)/(?P<limit>\d+)\)"
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        required=True,
        help="Diff base kept for CI command compatibility.",
    )
    parser.add_argument("files", nargs="+", help="Paths to pass to Pylint")
    args = parser.parse_args(argv)

    pylint_output = _run(
        [
            sys.executable,
            "-m",
            "pylint",
            *args.files,
            "--disable=all",
            "--enable=too-many-lines",
            "--score=n",
        ],
        check=False,
    )
    ignored_explicit_all_paths: set[str] = set()
    messages = _filter_file_length_messages(
        pylint_output.stdout,
        module_root=Path.cwd(),
        ignored_explicit_all_paths=ignored_explicit_all_paths,
    )
    if messages:
        print("Pylint file-length violations:")
        for message in messages:
            print(message)
        return 16
    if ignored_explicit_all_paths:
        print(
            "Ignored explicit __all__ declaration lines for: "
            + ", ".join(sorted(ignored_explicit_all_paths))
        )
    print("No blocking Pylint file-length violations.")
    return 0


def _filter_file_length_messages(
    output: str,
    *,
    module_root: Path | None = None,
    ignored_explicit_all_paths: set[str] | None = None,
) -> list[str]:
    messages: list[str] = []
    for line in output.splitlines():
        match = _PYLINT_MESSAGE_RE.match(line)
        if match is None:
            continue
        if match.group("code") != "C0302":
            continue
        path = match.group("path")
        if module_root is not None and _fits_after_explicit_all_declarations(
            line,
            path=path,
            module_root=module_root,
        ):
            if ignored_explicit_all_paths is not None:
                ignored_explicit_all_paths.add(path)
            continue
        messages.append(line)
    return messages


def _fits_after_explicit_all_declarations(
    message: str,
    *,
    path: str,
    module_root: Path,
) -> bool:
    count_match = _PYLINT_FILE_LENGTH_RE.search(message)
    if count_match is None:
        return False
    actual_line_count = int(count_match.group("actual"))
    limit = int(count_match.group("limit"))
    try:
        source = (module_root / path).read_text(encoding="utf-8")
    except OSError:
        return False
    explicit_all_lines = _explicit_all_declaration_line_count(source)
    return explicit_all_lines > 0 and actual_line_count - explicit_all_lines <= limit


def _explicit_all_declaration_line_count(source: str) -> int:
    try:
        module = ast.parse(source)
    except SyntaxError:
        return 0
    spans: list[tuple[int, int]] = []
    for statement in module.body:
        if not _is_explicit_all_assignment(statement) or statement.end_lineno is None:
            continue
        spans.append((statement.lineno, statement.end_lineno))
    return sum(end - start + 1 for start, end in _merge_line_spans(spans))


def _is_explicit_all_assignment(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.Assign):
        if not any(_is_all_target(target) for target in statement.targets):
            return False
        return _is_explicit_all_value(statement.value)
    if isinstance(statement, ast.AnnAssign):
        if statement.value is None or not _is_all_target(statement.target):
            return False
        return _is_explicit_all_value(statement.value)
    return False


def _is_all_target(target: ast.expr) -> bool:
    return isinstance(target, ast.Name) and target.id == "__all__"


def _is_explicit_all_value(value: ast.expr) -> bool:
    if not isinstance(value, (ast.List, ast.Tuple)):
        return False
    return all(
        isinstance(element, ast.Constant) and isinstance(element.value, str)
        for element in value.elts
    )


def _merge_line_spans(spans: Sequence[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if not merged or start > merged[-1][1] + 1:
            merged.append((start, end))
            continue
        previous_start, previous_end = merged[-1]
        merged[-1] = (previous_start, max(previous_end, end))
    return merged


def _run(
    command: Sequence[str],
    *,
    check: bool,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


if __name__ == "__main__":
    sys.exit(main())
