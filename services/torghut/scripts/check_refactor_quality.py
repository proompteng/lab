#!/usr/bin/env python3
"""Reject low-quality Torghut refactor patterns in changed Python files."""

from __future__ import annotations

import argparse
import ast
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

SERVICE_PREFIX = "services/torghut/"
TRACKED_PREFIXES = (
    "services/torghut/app/",
    "services/torghut/scripts/",
    "services/torghut/tests/",
    "services/torghut/migrations/",
)
PYTHON_SUFFIXES = (".py", ".pyi")
SELF_PATH = "scripts/check_refactor_quality.py"

GENERATED_SPLIT_NAME_RE = re.compile(
    r"^(?:part_\d+|source_part_\d+|test_part_\d+).*\.(?:py|pyi)$"
)
FORBIDDEN_TEXT_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bglobals\(\)\.update\("), "dynamic globals re-export"),
    (
        re.compile(r"\b__CompatModule__\b|\bCompatModule\b"),
        "custom compatibility module wrapper",
    ),
    (
        re.compile(r"\b__compat_part_modules__\b"),
        "generated part-module compatibility registry",
    ),
    (re.compile(r"sys\.modules\[[^\]]+\]\.__class__\s*="), "module class mutation"),
    (re.compile(r"sys\.modules\[[^\]]+\]\s*="), "module replacement"),
    (
        re.compile(r"^\s*#\s*pyright:.*(?:=false|\bignore\b)"),
        "file-level Pyright suppression",
    ),
    (re.compile(r"#\s*type:\s*ignore\b"), "type-check suppression"),
    (re.compile(r"^\s*#\s*ruff:\s*noqa\b"), "file-level Ruff suppression"),
    (
        re.compile(r"^\s*#\s*pylint:\s*disable=.*(?:too-many-lines|all)"),
        "blanket Pylint suppression",
    ),
)


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    reason: str
    detail: str

    def render(self) -> str:
        location = self.path if self.line <= 0 else f"{self.path}:{self.line}"
        return f"{location}: {self.reason}: {self.detail}"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fail changed Torghut Python files that use generated split names, "
            "dynamic compatibility facades, or blanket static-check suppressions."
        )
    )
    parser.add_argument("--base-ref", default="")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Scan every tracked Torghut Python file instead of only changed files.",
    )
    return parser.parse_args()


def _repo_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    raise RuntimeError("repo_root_not_found")


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
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
    github_base_ref = os.environ.get("GITHUB_BASE_REF", "").strip()
    if github_base_ref:
        return f"origin/{github_base_ref}"
    return None


def _resolve_diff_base(repo_root: Path, explicit_base_ref: str) -> str | None:
    base_spec = _resolve_base_spec(explicit_base_ref)
    if base_spec is not None:
        return _git_optional(repo_root, "merge-base", base_spec, "HEAD")
    for fallback_ref in ("origin/main", "main"):
        merge_base = _git_optional(repo_root, "merge-base", fallback_ref, "HEAD")
        if merge_base is not None:
            return merge_base
    return _git_optional(repo_root, "rev-parse", "HEAD^")


def _is_tracked_python_path(path: str) -> bool:
    normalized = path.strip().replace("\\", "/")
    return normalized.endswith(PYTHON_SUFFIXES) and normalized.startswith(
        TRACKED_PREFIXES
    )


def _changed_python_files(repo_root: Path, base_ref: str) -> tuple[str, ...]:
    base = _resolve_diff_base(repo_root, base_ref)
    changed: set[str] = set()
    if base is not None:
        diff_output = _git(
            repo_root, "diff", "--name-only", "--diff-filter=ACMR", f"{base}...HEAD"
        )
        changed.update(
            path for path in diff_output.splitlines() if _is_tracked_python_path(path)
        )
    for diff_args in (
        ("diff", "--name-only", "--diff-filter=ACMR", "HEAD"),
        ("diff", "--cached", "--name-only", "--diff-filter=ACMR", "HEAD"),
    ):
        diff_output = _git_optional(repo_root, *diff_args)
        if not diff_output:
            continue
        changed.update(
            path for path in diff_output.splitlines() if _is_tracked_python_path(path)
        )
    untracked_output = _git_optional(
        repo_root,
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        *TRACKED_PREFIXES,
    )
    if untracked_output:
        changed.update(
            path
            for path in untracked_output.splitlines()
            if _is_tracked_python_path(path)
        )
    return tuple(sorted(path[len(SERVICE_PREFIX) :] for path in changed))


def _all_python_files(repo_root: Path) -> tuple[str, ...]:
    output = _git(repo_root, "ls-files", "--", *TRACKED_PREFIXES)
    return tuple(
        sorted(
            path[len(SERVICE_PREFIX) :]
            for path in output.splitlines()
            if _is_tracked_python_path(path)
        )
    )


def _filename_violations(paths: Iterable[str]) -> list[Violation]:
    violations: list[Violation] = []
    for relative_path in paths:
        if relative_path == SELF_PATH:
            continue
        if GENERATED_SPLIT_NAME_RE.match(Path(relative_path).name):
            violations.append(
                Violation(
                    path=relative_path,
                    line=0,
                    reason="generated split filename",
                    detail="use a semantic responsibility-based module name",
                )
            )
    return violations


def _text_violations(relative_path: str, text: str) -> list[Violation]:
    violations: list[Violation] = []
    if relative_path == SELF_PATH:
        return violations
    for line_number, line in enumerate(text.splitlines(), start=1):
        for pattern, reason in FORBIDDEN_TEXT_PATTERNS:
            if pattern.search(line):
                violations.append(
                    Violation(
                        path=relative_path,
                        line=line_number,
                        reason=reason,
                        detail=line.strip(),
                    )
                )
    return violations


def _ast_violations(relative_path: str, text: str) -> list[Violation]:
    if relative_path == SELF_PATH:
        return []
    tree = ast.parse(text, filename=relative_path)
    violations: list[Violation] = []
    for node in ast.walk(tree):
        violations.extend(_node_violations(relative_path, node))
    return violations


def _node_violations(relative_path: str, node: ast.AST) -> list[Violation]:
    if isinstance(node, ast.ClassDef):
        return _class_violations(relative_path, node)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return _function_violations(relative_path, node)
    if isinstance(node, ast.Assign):
        return _assignment_violations(relative_path, node)
    if isinstance(node, ast.ImportFrom):
        return _import_from_violations(relative_path, node)
    return []


def _class_violations(relative_path: str, node: ast.ClassDef) -> list[Violation]:
    violations: list[Violation] = []
    for base in node.bases:
        if _is_module_type_base(base):
            violations.append(
                Violation(
                    path=relative_path,
                    line=node.lineno,
                    reason="custom module class",
                    detail=f"class {node.name}",
                )
            )
    return violations


def _function_violations(
    relative_path: str, node: ast.FunctionDef | ast.AsyncFunctionDef
) -> list[Violation]:
    if node.col_offset != 0 or node.name not in {"__getattr__", "__setattr__"}:
        return []
    return [
        Violation(
            path=relative_path,
            line=node.lineno,
            reason="module-level dynamic attribute hook",
            detail=f"def {node.name}",
        )
    ]


def _assignment_violations(relative_path: str, node: ast.Assign) -> list[Violation]:
    violations: list[Violation] = []
    for target in node.targets:
        if _is_sys_modules_subscript(target):
            violations.append(
                Violation(
                    path=relative_path,
                    line=node.lineno,
                    reason="module replacement",
                    detail="assignment to sys.modules[...]",
                )
            )
        if _is_dynamic_all_assignment(target, node.value):
            violations.append(
                Violation(
                    path=relative_path,
                    line=node.lineno,
                    reason="dynamic __all__",
                    detail="define explicit public exports",
                )
            )
    return violations


def _import_from_violations(
    relative_path: str, node: ast.ImportFrom
) -> list[Violation]:
    if not any(alias.name == "*" for alias in node.names):
        return []
    module = "." * node.level + (node.module or "")
    return [
        Violation(
            path=relative_path,
            line=node.lineno,
            reason="wildcard import",
            detail=f"from {module} import *",
        )
    ]


def _is_module_type_base(node: ast.AST) -> bool:
    if isinstance(node, ast.Name):
        return node.id == "ModuleType"
    return isinstance(node, ast.Attribute) and node.attr == "ModuleType"


def _is_dynamic_all_assignment(target: ast.AST, value: ast.AST) -> bool:
    return (
        isinstance(target, ast.Name)
        and target.id == "__all__"
        and _contains_globals_call(value)
    )


def _is_sys_modules_subscript(node: ast.AST) -> bool:
    if not isinstance(node, ast.Subscript):
        return False
    value = node.value
    return (
        isinstance(value, ast.Attribute)
        and value.attr == "modules"
        and isinstance(value.value, ast.Name)
        and value.value.id == "sys"
    )


def _contains_globals_call(node: ast.AST) -> bool:
    for candidate in ast.walk(node):
        if (
            isinstance(candidate, ast.Call)
            and isinstance(candidate.func, ast.Name)
            and candidate.func.id == "globals"
        ):
            return True
    return False


def _scan_file(service_root: Path, relative_path: str) -> list[Violation]:
    text = (service_root / relative_path).read_text(encoding="utf-8")
    return [
        *_text_violations(relative_path, text),
        *_ast_violations(relative_path, text),
    ]


def main() -> int:
    args = _parse_args()
    repo_root = _repo_root(Path.cwd())
    service_root = repo_root / "services" / "torghut"
    paths = (
        _all_python_files(repo_root)
        if args.all
        else _changed_python_files(repo_root, args.base_ref)
    )
    violations = [*_filename_violations(paths)]
    for relative_path in paths:
        if not (service_root / relative_path).exists():
            continue
        violations.extend(_scan_file(service_root, relative_path))
    if not violations:
        print(f"Refactor quality guard passed for {len(paths)} Torghut Python file(s).")
        return 0
    print("Torghut refactor quality guard failed:")
    for violation in violations:
        print(f"  - {violation.render()}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
