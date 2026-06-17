"""Pylint checks for Torghut refactor quality rules."""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import NamedTuple

from astroid import nodes
from pylint.checkers import BaseChecker
from pylint.lint import PyLinter

PLUGIN_PATH = Path(__file__).resolve()

GENERATED_SPLIT_NAME_RE = re.compile(
    r"^(?:part_\d+|source_part_\d+|test_part_\d+).*\.(?:py|pyi)$"
)
PYRIGHT_PRIVATE_USAGE_SETTING = "report" + "PrivateUsage"


class TextRule(NamedTuple):
    pattern: re.Pattern[str]
    symbol: str
    reason: str


FORBIDDEN_TEXT_RULES: tuple[TextRule, ...] = (
    TextRule(
        re.compile(r"\bglobals\(\)\.update\("),
        "torghut-dynamic-globals-reexport",
        "dynamic globals re-export",
    ),
    TextRule(
        re.compile(r"\b__CompatModule__\b|\bCompatModule\b"),
        "torghut-compat-module-wrapper",
        "custom compatibility module wrapper",
    ),
    TextRule(
        re.compile(r"\b__compat_" + "par" + r"t_modules__\b"),
        "torghut-compat-module-registry",
        "generated compatibility registry",
    ),
    TextRule(
        re.compile(r"sys\.modules\[[^\]]+\]\.__class__\s*="),
        "torghut-module-class-mutation",
        "module class mutation",
    ),
    TextRule(
        re.compile(r"sys\.modules\[[^\]]+\]\s*="),
        "torghut-module-replacement",
        "module replacement",
    ),
    TextRule(
        re.compile(
            rf"^\s*#\s*pyright:.*\b{PYRIGHT_PRIVATE_USAGE_SETTING}\s*=\s*false\b"
        ),
        "torghut-private-pyright-suppression",
        "private-usage Pyright suppression",
    ),
    TextRule(
        re.compile(r"^\s*#\s*pyright:.*(?:=false|\bignore\b)"),
        "torghut-file-pyright-suppression",
        "file-level Pyright suppression",
    ),
    TextRule(
        re.compile(r"#\s*type:\s*ignore\b"),
        "torghut-type-ignore",
        "type-check suppression",
    ),
    TextRule(
        re.compile(r"^\s*#\s*ruff:\s*noqa\b"),
        "torghut-file-ruff-noqa",
        "file-level Ruff suppression",
    ),
    TextRule(
        re.compile(r"^\s*#\s*pylint:\s*disable=.*(?:too-many-lines|all)"),
        "torghut-blanket-pylint-disable",
        "blanket Pylint suppression",
    ),
)


class TorghutQualityChecker(BaseChecker):
    name = "torghut-quality"
    msgs = {
        "C9001": (
            "Generated split filename %s; use a semantic module name",
            "torghut-generated-split-filename",
            "Used when a changed Torghut Python file keeps part_* generated naming.",
        ),
        "C9002": (
            "%s: %s",
            "torghut-dynamic-globals-reexport",
            "Used when a module re-exports another module through globals().update.",
        ),
        "C9003": (
            "%s: %s",
            "torghut-compat-module-wrapper",
            "Used when a module implements a custom compatibility ModuleType wrapper.",
        ),
        "C9004": (
            "%s: %s",
            "torghut-compat-module-registry",
            "Used when generated part-module compatibility registries are present.",
        ),
        "C9005": (
            "%s: %s",
            "torghut-module-class-mutation",
            "Used when code mutates a module object's class.",
        ),
        "C9006": (
            "%s: %s",
            "torghut-module-replacement",
            "Used when code replaces an entry in sys.modules.",
        ),
        "C9007": (
            "%s: %s",
            "torghut-file-pyright-suppression",
            "Used when a file-level Pyright suppression disables checking.",
        ),
        "C9008": (
            "%s: %s",
            "torghut-type-ignore",
            "Used when a type-check suppression is present.",
        ),
        "C9009": (
            "%s: %s",
            "torghut-file-ruff-noqa",
            "Used when a file-level Ruff suppression disables linting.",
        ),
        "C9010": (
            "%s: %s",
            "torghut-blanket-pylint-disable",
            "Used when blanket Pylint suppressions disable size or all checks.",
        ),
        "C9011": (
            "Module-level dynamic attribute hook %s; use explicit exports",
            "torghut-dynamic-attribute-hook",
            "Used when modules define top-level __getattr__ or __setattr__ hooks.",
        ),
        "C9012": (
            "Dynamic __all__; define explicit public exports",
            "torghut-dynamic-all",
            "Used when __all__ is built from globals().",
        ),
        "C9013": (
            "Wildcard import from %s; import explicit names",
            "torghut-wildcard-import",
            "Used when a module imports every symbol from another module.",
        ),
        "C9014": (
            "Custom module class %s; use normal modules and explicit exports",
            "torghut-custom-module-class",
            "Used when a class extends ModuleType to build module facades.",
        ),
        "C9015": (
            "Dead test compatibility wrapper; delete the wrapper and run split tests directly",
            "torghut-test-compat-wrapper",
            "Used when a test module only disables collection and re-exports split tests.",
        ),
        "C9016": (
            "%s: %s",
            "torghut-private-pyright-suppression",
            "Used when a file-level Pyright suppression disables private-usage checks.",
        ),
    }

    def visit_module(self, node: nodes.Module) -> None:
        path = Path(str(getattr(node, "file", "")))
        if path.resolve() == PLUGIN_PATH:
            return
        self._check_filename(node, path)
        text = _read_text(path)
        if text is None:
            return
        self._check_text(node, text)
        self._check_ast(node, text)
        self._check_test_wrapper(node, path, text)

    def _check_filename(self, module_node: nodes.Module, path: Path) -> None:
        if GENERATED_SPLIT_NAME_RE.match(path.name):
            self.add_message(
                "torghut-generated-split-filename",
                node=module_node,
                line=1,
                args=(path.name,),
            )

    def _check_text(self, module_node: nodes.Module, text: str) -> None:
        for line_number, line in enumerate(text.splitlines(), start=1):
            for rule in FORBIDDEN_TEXT_RULES:
                if rule.pattern.search(line):
                    self.add_message(
                        rule.symbol,
                        node=module_node,
                        line=line_number,
                        args=(rule.reason, line.strip()),
                    )

    def _check_ast(self, module_node: nodes.Module, text: str) -> None:
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return
        for node in ast.walk(tree):
            self._check_node(module_node, node)

    def _check_node(self, module_node: nodes.Module, node: ast.AST) -> None:
        if isinstance(node, ast.ClassDef):
            self._check_class(module_node, node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self._check_function(module_node, node)
        elif isinstance(node, ast.Assign):
            self._check_assignment(module_node, node)
        elif isinstance(node, ast.ImportFrom):
            self._check_import_from(module_node, node)

    def _check_class(self, module_node: nodes.Module, node: ast.ClassDef) -> None:
        if any(_is_module_type_base(base) for base in node.bases):
            self.add_message(
                "torghut-custom-module-class",
                node=module_node,
                line=node.lineno,
                args=(node.name,),
            )

    def _check_function(
        self, module_node: nodes.Module, node: ast.FunctionDef | ast.AsyncFunctionDef
    ) -> None:
        if node.col_offset == 0 and node.name in {"__getattr__", "__setattr__"}:
            self.add_message(
                "torghut-dynamic-attribute-hook",
                node=module_node,
                line=node.lineno,
                args=(node.name,),
            )

    def _check_assignment(self, module_node: nodes.Module, node: ast.Assign) -> None:
        if any(
            _is_dynamic_all_assignment(target, node.value) for target in node.targets
        ):
            self.add_message("torghut-dynamic-all", node=module_node, line=node.lineno)

    def _check_import_from(
        self, module_node: nodes.Module, node: ast.ImportFrom
    ) -> None:
        if not any(alias.name == "*" for alias in node.names):
            return
        module = "." * node.level + (node.module or "")
        self.add_message(
            "torghut-wildcard-import",
            node=module_node,
            line=node.lineno,
            args=(module,),
        )

    def _check_test_wrapper(
        self, module_node: nodes.Module, path: Path, text: str
    ) -> None:
        if not _is_dead_test_compat_wrapper(path, text):
            return
        self.add_message(
            "torghut-test-compat-wrapper",
            node=module_node,
            line=1,
        )


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


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


def _contains_globals_call(node: ast.AST) -> bool:
    for candidate in ast.walk(node):
        if (
            isinstance(candidate, ast.Call)
            and isinstance(candidate.func, ast.Name)
            and candidate.func.id == "globals"
        ):
            return True
    return False


def _is_dead_test_compat_wrapper(path: Path, text: str) -> bool:
    if not path.name.startswith("test_"):
        return False
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return False

    saw_test_disabled = False
    saw_import = False
    for node in tree.body:
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            continue
        if isinstance(node, ast.Assign) and _is_test_false_assignment(node):
            saw_test_disabled = True
            continue
        if _is_future_annotations_import(node):
            continue
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            saw_import = True
            continue
        return False
    return (saw_test_disabled and saw_import) or _is_empty_suppression_only_test(text)


def _is_future_annotations_import(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.ImportFrom)
        and node.module == "__future__"
        and any(alias.name == "annotations" for alias in node.names)
    )


def _is_empty_suppression_only_test(text: str) -> bool:
    saw_ruff_noqa = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped == "from __future__ import annotations":
            continue
        if stripped.startswith("# ruff: noqa"):
            saw_ruff_noqa = True
            continue
        return False
    return saw_ruff_noqa


def _is_test_false_assignment(node: ast.Assign) -> bool:
    return (
        len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "__test__"
        and isinstance(node.value, ast.Constant)
        and node.value.value is False
    )


def register(linter: PyLinter) -> None:
    linter.register_checker(TorghutQualityChecker(linter))
