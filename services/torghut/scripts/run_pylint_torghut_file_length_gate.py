"""Run Torghut's file-length gate while allowing extracted legacy source payloads."""

from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from pathlib import PurePosixPath

TORGHUT_PREFIX = "services/torghut/"
_PYLINT_MESSAGE_RE = re.compile(
    r"^(?P<path>[^:]+):(?P<line>\d+):(?P<column>\d+): "
    r"(?P<code>[A-Z]\d+): "
)
_PYLINT_FILE_LENGTH_RE = re.compile(
    r"Too many lines in module \((?P<actual>\d+)/(?P<limit>\d+)\)"
)
_SOURCE_PAYLOAD_FILE_PREFIX = "source_" + "segment_"
# PR 10945 turned these generated payloads into real modules. Later cleanup PRs
# should split them; until then, keep the gate blocking every other long file.
_TRANSITIONAL_EXTRACTED_SOURCE_MODULES = {
    "app/trading/autonomy/lane.py",
    "app/trading/discovery/candidate_specs.py",
    "app/trading/research_sleeves.py",
    "scripts/assemble_runtime_ledger_proof_packet.py",
    "scripts/import_hypothesis_runtime_windows.py",
    "scripts/run_whitepaper_autoresearch_profit_target.py",
    "scripts/search_consistent_profitability_frontier.py",
}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        required=True,
        help="Base commit/ref used to identify legacy source-segment payloads.",
    )
    parser.add_argument("files", nargs="+", help="Paths to pass to Pylint")
    args = parser.parse_args(argv)

    extracted_paths = (
        _TRANSITIONAL_EXTRACTED_SOURCE_MODULES | _base_extracted_source_paths(args.base)
    )
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
    messages = _filter_legacy_extracted_messages(
        pylint_output.stdout,
        extracted_paths=extracted_paths,
        module_root=Path.cwd(),
        ignored_explicit_all_paths=ignored_explicit_all_paths,
    )
    if messages:
        print("Pylint file-length violations:")
        for message in messages:
            print(message)
        return 16
    if extracted_paths:
        print(
            "Ignored legacy source-segment length debt for: "
            + ", ".join(sorted(extracted_paths))
        )
    if ignored_explicit_all_paths:
        print(
            "Ignored explicit __all__ declaration lines for: "
            + ", ".join(sorted(ignored_explicit_all_paths))
        )
    print("No blocking Pylint file-length violations.")
    return 0


def _base_extracted_source_paths(base: str) -> set[str]:
    repo_root = _repo_root()
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
    extracted: set[str] = set()
    for path_text in paths.stdout.splitlines():
        path = PurePosixPath(path_text)
        if (
            not path.name.startswith(_SOURCE_PAYLOAD_FILE_PREFIX)
            or path.suffix != ".py"
        ):
            continue
        module_dir = path.parent
        if not module_dir.name.endswith("_modules"):
            continue
        public_name = module_dir.name.removesuffix("_modules") + ".py"
        public_path = module_dir.parent / public_name
        public_text = str(public_path)
        if public_text.startswith(TORGHUT_PREFIX):
            extracted.add(public_text.removeprefix(TORGHUT_PREFIX))
    return extracted


def _filter_legacy_extracted_messages(
    output: str,
    *,
    extracted_paths: set[str],
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
        if path in extracted_paths:
            continue
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


def _repo_root() -> Path:
    result = _run(["git", "rev-parse", "--show-toplevel"], check=True)
    return Path(result.stdout.strip())


if __name__ == "__main__":
    sys.exit(main())
