"""Run Pylint rules on changed Torghut diff lines."""

from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

TORGHUT_PREFIX = "services/torghut/"
CUSTOM_RULES = (
    "torghut-generated-split-filename",
    "torghut-dynamic-globals-reexport",
    "torghut-compat-module-wrapper",
    "torghut-compat-module-registry",
    "torghut-module-class-mutation",
    "torghut-module-replacement",
    "torghut-private-pyright-suppression",
    "torghut-wildcard-ruff-noqa",
    "torghut-blanket-pylint-disable",
    "torghut-dynamic-attribute-hook",
    "torghut-wildcard-import",
    "torghut-custom-module-class",
    "torghut-test-compat-wrapper",
    "torghut-source-string-execution",
)

_DIFF_FILE_RE = re.compile(r"^\+\+\+ b/(.+)$")
_DIFF_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
_PYLINT_MESSAGE_RE = re.compile(
    r"^(?P<path>[^:]+):(?P<line>\d+):(?P<column>\d+): "
    r"(?P<code>[A-Z]\d+): "
)
_PRIVATE_DEFINITION_RE = re.compile(
    r"^(?P<prefix>\s*(?:async\s+def|def|class)\s+)_(?P<name>[A-Za-z][A-Za-z0-9_]*\b)"
)
_SOURCE_PAYLOAD_FILE_PREFIX = "source_" + "segment_"


@dataclass(frozen=True)
class PylintMessage:
    path: str
    line: int
    raw: str


def parse_changed_lines(diff_text: str) -> dict[str, set[int]]:
    changed: dict[str, set[int]] = {}
    current_path: str | None = None
    for line in diff_text.splitlines():
        file_match = _DIFF_FILE_RE.match(line)
        if file_match:
            current_path = _torghut_relative_path(file_match.group(1))
            if current_path is not None:
                changed.setdefault(current_path, set())
            continue

        hunk_match = _DIFF_HUNK_RE.match(line)
        if hunk_match is None or current_path is None:
            continue
        start = int(hunk_match.group(1))
        count = int(hunk_match.group(2) or "1")
        if count <= 0:
            continue
        changed.setdefault(current_path, set()).update(range(start, start + count))
    return changed


def parse_pylint_messages(output: str) -> list[PylintMessage]:
    messages: list[PylintMessage] = []
    for line in output.splitlines():
        match = _PYLINT_MESSAGE_RE.match(line)
        if match is None:
            continue
        messages.append(
            PylintMessage(
                path=match.group("path"),
                line=int(match.group("line")),
                raw=line,
            )
        )
    return messages


def filter_messages(
    messages: Iterable[PylintMessage],
    changed_lines: dict[str, set[int]],
) -> list[PylintMessage]:
    return [
        message
        for message in messages
        if message.line in changed_lines.get(message.path, set())
    ]


def filter_base_line_messages(
    messages: Iterable[PylintMessage],
    *,
    base: str,
    current_root: Path,
    repo_root: Path,
) -> list[PylintMessage]:
    base_lines = _base_torghut_app_script_lines(base, repo_root)
    filtered: list[PylintMessage] = []
    for message in messages:
        line_text = _line_text(current_root / message.path, message.line)
        if line_text is not None and line_text.strip() in base_lines:
            continue
        filtered.append(message)
    return filtered


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base", required=True, help="Base commit/ref for changed lines"
    )
    parser.add_argument(
        "--enable",
        default=",".join(CUSTOM_RULES),
        help="Comma-separated Pylint rules to enable",
    )
    parser.add_argument(
        "--load-plugins",
        default="scripts.pylint_torghut_quality",
        help="Comma-separated Pylint plugins to load, or an empty string",
    )
    parser.add_argument(
        "--ignore-base-lines",
        action="store_true",
        help="Ignore changed-line messages whose current source line already exists in the base app/scripts tree.",
    )
    parser.add_argument("files", nargs="+", help="Torghut-relative Python files")
    args = parser.parse_args(argv)

    repo_root = _repo_root()
    diff_text = _run(
        [
            "git",
            "diff",
            "--unified=0",
            "--find-renames",
            "--diff-filter=ACMR",
            f"{args.base}...HEAD",
            "--",
            *[f"{TORGHUT_PREFIX}{path}" for path in args.files],
        ],
        cwd=repo_root,
        check=True,
    ).stdout
    changed_lines = parse_changed_lines(diff_text)
    pylint_command = [sys.executable, "-m", "pylint"]
    if args.load_plugins:
        pylint_command.append(f"--load-plugins={args.load_plugins}")
    pylint_command.extend(
        (
            "--disable=all",
            f"--enable={args.enable}",
            "--score=n",
            *args.files,
        )
    )
    pylint_output = _run(
        pylint_command,
        cwd=Path.cwd(),
        check=False,
    )
    messages = filter_messages(
        parse_pylint_messages(pylint_output.stdout), changed_lines
    )
    if args.ignore_base_lines:
        messages = filter_base_line_messages(
            messages,
            base=args.base,
            current_root=Path.cwd(),
            repo_root=repo_root,
        )
    if messages:
        print("Pylint violations on changed lines:")
        for message in messages:
            print(message.raw)
        return 16
    print("No changed-line Pylint violations.")
    return 0


def _repo_root() -> Path:
    result = _run(["git", "rev-parse", "--show-toplevel"], cwd=Path.cwd(), check=True)
    return Path(result.stdout.strip())


def _run(
    command: Sequence[str],
    *,
    cwd: Path,
    check: bool,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def _torghut_relative_path(path: str) -> str | None:
    if not path.startswith(TORGHUT_PREFIX):
        return None
    return path.removeprefix(TORGHUT_PREFIX)


def _base_torghut_app_script_lines(base: str, repo_root: Path) -> set[str]:
    content = _run(
        [
            "git",
            "grep",
            "-h",
            "-I",
            "-e",
            ".",
            base,
            "--",
            "services/torghut/app",
            "services/torghut/scripts",
        ],
        cwd=repo_root,
        check=False,
    )
    if content.returncode not in {0, 1}:
        raise RuntimeError(content.stdout)
    lines = _source_line_equivalents(content.stdout.splitlines())
    lines.update(_base_generated_payload_lines(base, repo_root))
    return lines


def _base_generated_payload_lines(base: str, repo_root: Path) -> set[str]:
    paths = _run(
        [
            "git",
            "ls-tree",
            "-r",
            "--name-only",
            base,
            "--",
            "services/torghut/app",
            "services/torghut/scripts",
        ],
        cwd=repo_root,
        check=True,
    )
    segment_lines: set[str] = set()
    for path in paths.stdout.splitlines():
        if f"/{_SOURCE_PAYLOAD_FILE_PREFIX}" not in path or not path.endswith(".py"):
            continue
        segment_source = _run(
            ["git", "show", f"{base}:{path}"],
            cwd=repo_root,
            check=False,
        )
        if segment_source.returncode != 0:
            continue
        segment_lines.update(
            _source_line_equivalents(_source_literal_lines(segment_source.stdout))
        )
    return segment_lines


def _source_line_equivalents(lines: Iterable[str]) -> set[str]:
    equivalents: set[str] = set()
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        equivalents.add(stripped)
        private_definition = _PRIVATE_DEFINITION_RE.match(line)
        if private_definition is not None:
            normalized = (
                f"{private_definition.group('prefix')}{private_definition.group('name')}"
                f"{line[private_definition.end() :]}"
            )
            equivalents.add(normalized.strip())
    return equivalents


def _source_literal_lines(module_text: str) -> set[str]:
    try:
        tree = ast.parse(module_text)
    except SyntaxError:
        return set()
    lines: set[str] = set()
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == "SOURCE"
            for target in node.targets
        ):
            continue
        try:
            source = ast.literal_eval(node.value)
        except (SyntaxError, ValueError):
            continue
        if not isinstance(source, str):
            continue
        lines.update(line.strip() for line in source.splitlines() if line.strip())
    return lines


def _line_text(path: Path, line_number: int) -> str | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    index = line_number - 1
    if index < 0 or index >= len(lines):
        return None
    return lines[index]


if __name__ == "__main__":
    sys.exit(main())
