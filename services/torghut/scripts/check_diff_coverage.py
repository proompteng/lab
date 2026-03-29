#!/usr/bin/env python3
"""Fail when changed Torghut Python source lines are under the required coverage threshold."""

from __future__ import annotations

import argparse
import ast
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

SERVICE_PREFIX = 'services/torghut/'
TRACKED_PREFIXES = (
    'services/torghut/app/',
    'services/torghut/scripts/',
)
_HUNK_RE = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')


@dataclass(frozen=True)
class FileDiffCoverage:
    filename: str
    executable_changed_lines: int
    covered_lines: int
    missing_lines: tuple[int, ...]
    missing_from_coverage: bool = False

    @property
    def coverage_ratio(self) -> float:
        if self.executable_changed_lines <= 0:
            return 1.0
        return self.covered_lines / self.executable_changed_lines


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Validate changed-file coverage for Torghut Python source files.',
    )
    parser.add_argument('--coverage-xml', default='coverage.xml')
    parser.add_argument('--threshold', type=float, default=90.0)
    parser.add_argument('--base-ref', default='')
    return parser.parse_args()


def _repo_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / '.git').exists():
            return candidate
    raise RuntimeError('repo_root_not_found')


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ['git', *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _git_optional(cwd: Path, *args: str) -> str | None:
    try:
        return _git(cwd, *args)
    except subprocess.CalledProcessError:
        return None


def _resolve_base_spec(explicit_base_ref: str) -> str | None:
    if explicit_base_ref.strip():
        return explicit_base_ref.strip()
    github_base_ref = os.environ.get('GITHUB_BASE_REF', '').strip()
    if github_base_ref:
        return f'origin/{github_base_ref}'
    return None


def _resolve_diff_base(repo_root: Path, explicit_base_ref: str) -> str | None:
    base_spec = _resolve_base_spec(explicit_base_ref)
    if base_spec is not None:
        return _git_optional(repo_root, 'merge-base', base_spec, 'HEAD')
    for fallback_ref in ('origin/main', 'main'):
        merge_base = _git_optional(repo_root, 'merge-base', fallback_ref, 'HEAD')
        if merge_base is not None:
            return merge_base
    return _git_optional(repo_root, 'rev-parse', 'HEAD^')


def _parse_changed_python_lines(diff_text: str) -> dict[str, set[int]]:
    changed_lines: dict[str, set[int]] = {}
    current_filename: str | None = None

    for line in diff_text.splitlines():
        if line.startswith('+++ b/'):
            candidate = line[len('+++ b/') :].strip()
            current_filename = None
            if not candidate.endswith('.py'):
                continue
            if not candidate.startswith(TRACKED_PREFIXES):
                continue
            current_filename = candidate[len(SERVICE_PREFIX) :]
            changed_lines.setdefault(current_filename, set())
            continue
        if current_filename is None:
            continue
        match = _HUNK_RE.match(line)
        if not match:
            continue
        start_line = int(match.group(1))
        count = int(match.group(2) or '1')
        if count <= 0:
            continue
        changed_lines[current_filename].update(range(start_line, start_line + count))
    return changed_lines


def _list_untracked_python_files(repo_root: Path) -> tuple[str, ...]:
    output = _git_optional(
        repo_root,
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        *TRACKED_PREFIXES,
    )
    if not output:
        return ()
    files: list[str] = []
    for candidate in output.splitlines():
        normalized = candidate.strip().replace('\\', '/')
        if not normalized.endswith('.py'):
            continue
        if not normalized.startswith(TRACKED_PREFIXES):
            continue
        files.append(normalized[len(SERVICE_PREFIX) :])
    return tuple(sorted(files))


def _executable_source_lines(path: Path) -> set[int]:
    tree = ast.parse(path.read_text(encoding='utf-8'))
    line_numbers: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.stmt) and hasattr(node, 'lineno'):
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                continue
            line_numbers.add(node.lineno)
    return line_numbers


def _include_untracked_python_files(
    *,
    changed_lines: dict[str, set[int]],
    coverage_index: dict[str, dict[int, int]],
    service_root: Path,
    repo_root: Path,
) -> dict[str, set[int]]:
    combined = {filename: set(lines) for filename, lines in changed_lines.items()}
    for filename in _list_untracked_python_files(repo_root):
        if filename in coverage_index:
            combined.setdefault(filename, set()).update(coverage_index[filename])
            continue
        combined.setdefault(filename, set()).update(
            _executable_source_lines(service_root / filename)
        )
    return combined


def _load_coverage_index(xml_path: Path) -> dict[str, dict[int, int]]:
    tree = ET.parse(xml_path)
    root = tree.getroot()
    service_root = xml_path.resolve().parent
    coverage_index: dict[str, dict[int, int]] = {}
    for package_node in root.findall('.//package'):
        package_name = (package_node.get('name') or '').strip()
        for class_node in package_node.findall('./classes/class'):
            filename = class_node.get('filename')
            if not filename:
                continue
            normalized = filename.replace('\\', '/').lstrip('./')
            if '/' not in normalized and package_name in {'app', 'scripts'}:
                normalized = f'{package_name}/{normalized}'
            elif '/' not in normalized and package_name == '.':
                script_path = service_root / 'scripts' / normalized
                app_path = service_root / 'app' / normalized
                if script_path.exists() and not app_path.exists():
                    normalized = f'scripts/{normalized}'
                elif app_path.exists() and not script_path.exists():
                    normalized = f'app/{normalized}'
            line_hits = coverage_index.setdefault(normalized, {})
            for line_node in class_node.findall('./lines/line'):
                number = line_node.get('number')
                hits = line_node.get('hits')
                if number is None or hits is None:
                    continue
                line_hits[int(number)] = int(hits)
    return coverage_index


def summarize_changed_coverage(
    *,
    changed_lines: dict[str, set[int]],
    coverage_index: dict[str, dict[int, int]],
) -> list[FileDiffCoverage]:
    summary: list[FileDiffCoverage] = []
    for filename in sorted(changed_lines):
        changed = sorted(changed_lines[filename])
        line_hits = coverage_index.get(filename)
        if line_hits is None:
            summary.append(
                FileDiffCoverage(
                    filename=filename,
                    executable_changed_lines=len(changed),
                    covered_lines=0,
                    missing_lines=tuple(changed),
                    missing_from_coverage=True,
                )
            )
            continue
        executable_changed = sorted(line for line in changed if line in line_hits)
        if not executable_changed:
            continue
        missing = tuple(line for line in executable_changed if line_hits.get(line, 0) <= 0)
        summary.append(
            FileDiffCoverage(
                filename=filename,
                executable_changed_lines=len(executable_changed),
                covered_lines=len(executable_changed) - len(missing),
                missing_lines=missing,
            )
        )
    return summary


def _format_summary(summary: list[FileDiffCoverage]) -> str:
    lines: list[str] = []
    for item in summary:
        coverage_pct = item.coverage_ratio * 100
        suffix = ' missing-from-coverage' if item.missing_from_coverage else ''
        lines.append(
            f'{item.filename}: {item.covered_lines}/{item.executable_changed_lines} '
            f'lines covered ({coverage_pct:.2f}%){suffix}'
        )
        if item.missing_lines:
            lines.append(f'  missing lines: {", ".join(str(line) for line in item.missing_lines)}')
    return '\n'.join(lines)


def main() -> int:
    args = _parse_args()
    service_root = Path(__file__).resolve().parents[1]
    repo_root = _repo_root(service_root)
    base_commit = _resolve_diff_base(repo_root, args.base_ref)
    if base_commit is None:
        print('diff coverage skipped: no base commit available')
        return 0

    diff_text = _git(
        repo_root,
        'diff',
        '--unified=0',
        base_commit,
        '--',
        'services/torghut/app',
        'services/torghut/scripts',
    )
    changed_lines = _parse_changed_python_lines(diff_text)

    coverage_index = _load_coverage_index(Path(args.coverage_xml))
    changed_with_untracked = _include_untracked_python_files(
        changed_lines=changed_lines,
        coverage_index=coverage_index,
        service_root=service_root,
        repo_root=repo_root,
    )
    if not changed_with_untracked:
        print('diff coverage passed: no changed Torghut Python source lines')
        return 0
    summary = summarize_changed_coverage(
        changed_lines=changed_with_untracked,
        coverage_index=coverage_index,
    )
    if not summary:
        print('diff coverage passed: no changed executable Torghut Python source lines')
        return 0

    total_executable = sum(item.executable_changed_lines for item in summary)
    total_covered = sum(item.covered_lines for item in summary)
    coverage_pct = (total_covered / total_executable) * 100 if total_executable else 100.0
    print(_format_summary(summary))
    print(f'total changed-line coverage: {total_covered}/{total_executable} ({coverage_pct:.2f}%)')

    missing_files = [item.filename for item in summary if item.missing_from_coverage]
    if missing_files:
        print(
            'diff coverage failed: changed files missing from coverage.xml: '
            + ', '.join(missing_files),
            file=sys.stderr,
        )
        return 1
    if coverage_pct < args.threshold:
        print(
            f'diff coverage failed: {coverage_pct:.2f}% below threshold {args.threshold:.2f}%',
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
