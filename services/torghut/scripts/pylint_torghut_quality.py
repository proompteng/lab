"""Pylint checks for Torghut refactor quality rules."""

from __future__ import annotations

import ast
import io
import re
import tokenize
from pathlib import Path
from typing import NamedTuple, Protocol, cast

from pylint.checkers import BaseChecker
from pylint.lint import PyLinter
from pylint.typing import MessageDefinitionTuple

PLUGIN_PATH = Path(__file__).resolve()

GENERATED_SPLIT_NAME_RE = re.compile(
    r"^(?:part_\d+|source_part_\d+|source_segment_\d+|test_part_\d+).*\.(?:py|pyi)$"
)
PYRIGHT_PRIVATE_USAGE_SETTING = "reportPrivateUsage"


class CommentRule(NamedTuple):
    pattern: re.Pattern[str]
    symbol: str
    reason: str


class PylintMessageEmitter(Protocol):
    def __call__(
        self,
        msgid: str,
        line: int | None = None,
        node: object | None = None,
        args: object = None,
    ) -> None: ...


FORBIDDEN_COMMENT_RULES: tuple[CommentRule, ...] = (
    CommentRule(
        re.compile(
            rf"^\s*#\s*pyright:.*\b{PYRIGHT_PRIVATE_USAGE_SETTING}\s*=\s*false\b"
        ),
        "torghut-private-pyright-suppression",
        "private-usage Pyright suppression",
    ),
    CommentRule(
        re.compile(r"^\s*#\s*pyright:.*(?:=false|\bignore\b)"),
        "torghut-file-pyright-suppression",
        "file-level Pyright suppression",
    ),
    CommentRule(
        re.compile(r"#\s*type:\s*ignore\b"),
        "torghut-type-ignore",
        "type-check suppression",
    ),
    CommentRule(
        re.compile(r"^\s*#\s*ruff:\s*noqa\b"),
        "torghut-file-ruff-noqa",
        "file-level Ruff suppression",
    ),
    CommentRule(
        re.compile(r"^\s*#\s*ruff:\s*noqa:.*\bF(?:403|405)\b"),
        "torghut-wildcard-ruff-noqa",
        "wildcard-import Ruff suppression",
    ),
    CommentRule(
        re.compile(r"^\s*#\s*pylint:\s*disable=.*(?:too-many-lines|all)"),
        "torghut-blanket-pylint-disable",
        "blanket Pylint suppression",
    ),
)


TORGHUT_QUALITY_MESSAGES: dict[str, MessageDefinitionTuple] = {
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
        "Used when generated compatibility module registries are present.",
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
    "C9017": (
        "%s: %s",
        "torghut-wildcard-ruff-noqa",
        "Used when a file-level Ruff suppression keeps wildcard-import checks disabled.",
    ),
    "C9018": (
        "Dynamic exec call %s; move generated source into normal modules",
        "torghut-source-string-execution",
        "Used when code executes source strings instead of importing normal modules.",
    ),
    "C9019": (
        "Shadowed __all__ at line %s; keep a single explicit export list",
        "torghut-shadowed-all",
        "Used when a module defines top-level __all__ more than once.",
    ),
    "C9020": (
        "Empty __all__; delete the no-op export stub",
        "torghut-empty-all",
        "Used when a module defines an empty top-level __all__.",
    ),
    "C9021": (
        "Import from typing.Any; use a specific type boundary",
        "torghut-typing-any-import",
        "Used when changed runtime code imports typing.Any instead of a specific type boundary.",
    ),
    "C9022": (
        "Broad except Exception; catch a domain/dependency exception or document an allowlist",
        "torghut-broad-exception",
        "Used when changed runtime code catches Exception broadly.",
    ),
    "C9023": (
        "Do not catch BaseException in Torghut runtime code",
        "torghut-base-exception",
        "Used when changed runtime code catches BaseException.",
    ),
}


class TorghutQualityChecker(BaseChecker):
    name = "torghut-quality"
    msgs = TORGHUT_QUALITY_MESSAGES

    def visit_module(self, node: object) -> None:
        path = Path(str(getattr(node, "file", "")))
        if path.resolve() == PLUGIN_PATH:
            return
        self._check_filename(node, path)
        text = _read_text(path)
        if text is None:
            return
        self._check_comments(node, text)
        self._check_ast(node, text)
        self._check_test_wrapper(node, path, text)

    def _add_module_message(
        self,
        msgid: str,
        *,
        module_node: object,
        line: int,
        args: object = None,
    ) -> None:
        add_message = cast(PylintMessageEmitter, self.add_message)
        add_message(msgid, line=line, node=module_node, args=args)

    def _check_filename(self, module_node: object, path: Path) -> None:
        if GENERATED_SPLIT_NAME_RE.match(path.name):
            self._add_module_message(
                "torghut-generated-split-filename",
                module_node=module_node,
                line=1,
                args=(path.name,),
            )

    def _check_comments(self, module_node: object, text: str) -> None:
        try:
            tokens = tokenize.generate_tokens(io.StringIO(text).readline)
            comment_tokens = [
                token_info
                for token_info in tokens
                if token_info.type == tokenize.COMMENT
            ]
        except tokenize.TokenError:
            return

        for token_info in comment_tokens:
            comment = token_info.string
            line_number = token_info.start[0]
            for rule in FORBIDDEN_COMMENT_RULES:
                if rule.pattern.search(comment):
                    self._add_module_message(
                        rule.symbol,
                        module_node=module_node,
                        line=line_number,
                        args=(rule.reason, comment.strip()),
                    )

    def _check_ast(self, module_node: object, text: str) -> None:
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return
        self._check_shadowed_all(module_node, tree)
        self._check_empty_all(module_node, tree)
        for node in ast.walk(tree):
            self._check_node(module_node, node)

    def _check_shadowed_all(self, module_node: object, tree: ast.Module) -> None:
        all_assignments = [
            statement
            for statement in tree.body
            if _is_top_level_all_assignment(statement)
        ]
        for shadowed in all_assignments[:-1]:
            self._add_module_message(
                "torghut-shadowed-all",
                module_node=module_node,
                line=shadowed.lineno,
                args=(all_assignments[-1].lineno,),
            )

    def _check_empty_all(self, module_node: object, tree: ast.Module) -> None:
        for statement in tree.body:
            if _is_empty_all_assignment(statement):
                self._add_module_message(
                    "torghut-empty-all",
                    module_node=module_node,
                    line=statement.lineno,
                )

    def _check_node(self, module_node: object, node: ast.AST) -> None:
        if isinstance(node, ast.ClassDef):
            self._check_class(module_node, node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self._check_function(module_node, node)
        elif isinstance(node, ast.Assign):
            self._check_assignment(module_node, node)
        elif isinstance(node, ast.ImportFrom):
            self._check_import_from(module_node, node)
        elif isinstance(node, ast.ExceptHandler):
            self._check_except_handler(module_node, node)
        elif isinstance(node, ast.Call):
            self._check_call(module_node, node)

    def _check_class(self, module_node: object, node: ast.ClassDef) -> None:
        if node.name in {"CompatModule", "__CompatModule__"}:
            self._add_module_message(
                "torghut-compat-module-wrapper",
                module_node=module_node,
                line=node.lineno,
                args=("custom compatibility module wrapper", node.name),
            )
        if any(_is_module_type_base(base) for base in node.bases):
            self._add_module_message(
                "torghut-custom-module-class",
                module_node=module_node,
                line=node.lineno,
                args=(node.name,),
            )

    def _check_function(
        self, module_node: object, node: ast.FunctionDef | ast.AsyncFunctionDef
    ) -> None:
        if node.col_offset == 0 and node.name in {"__getattr__", "__setattr__"}:
            self._add_module_message(
                "torghut-dynamic-attribute-hook",
                module_node=module_node,
                line=node.lineno,
                args=(node.name,),
            )

    def _check_assignment(self, module_node: object, node: ast.Assign) -> None:
        if any(
            _is_dynamic_all_assignment(target, node.value) for target in node.targets
        ):
            self._add_module_message(
                "torghut-dynamic-all",
                module_node=module_node,
                line=node.lineno,
            )
        for target in node.targets:
            if _is_compat_module_registry_target(target):
                self._add_module_message(
                    "torghut-compat-module-registry",
                    module_node=module_node,
                    line=node.lineno,
                    args=("generated compatibility registry", ast.unparse(target)),
                )
        for target in node.targets:
            if _is_sys_modules_class_target(target):
                self._add_module_message(
                    "torghut-module-class-mutation",
                    module_node=module_node,
                    line=node.lineno,
                    args=("module class mutation", ast.unparse(target)),
                )
        for target in node.targets:
            if _is_sys_modules_replacement_target(target):
                self._add_module_message(
                    "torghut-module-replacement",
                    module_node=module_node,
                    line=node.lineno,
                    args=("module replacement", ast.unparse(target)),
                )

    def _check_import_from(self, module_node: object, node: ast.ImportFrom) -> None:
        if node.module == "typing" and any(alias.name == "Any" for alias in node.names):
            self._add_module_message(
                "torghut-typing-any-import",
                module_node=module_node,
                line=node.lineno,
            )
        if any(alias.name == "*" for alias in node.names):
            module = "." * node.level + (node.module or "")
            self._add_module_message(
                "torghut-wildcard-import",
                module_node=module_node,
                line=node.lineno,
                args=(module,),
            )

    def _check_except_handler(
        self, module_node: object, node: ast.ExceptHandler
    ) -> None:
        exception_name = _exception_handler_name(node.type)
        if exception_name == "Exception":
            self._add_module_message(
                "torghut-broad-exception",
                module_node=module_node,
                line=node.lineno,
            )
        elif exception_name == "BaseException":
            self._add_module_message(
                "torghut-base-exception",
                module_node=module_node,
                line=node.lineno,
            )

    def _check_call(self, module_node: object, node: ast.Call) -> None:
        if _is_globals_update_call(node):
            self._add_module_message(
                "torghut-dynamic-globals-reexport",
                module_node=module_node,
                line=node.lineno,
                args=("dynamic globals re-export", ast.unparse(node)),
            )
        if _is_exec_call(node):
            self._add_module_message(
                "torghut-source-string-execution",
                module_node=module_node,
                line=node.lineno,
                args=(ast.unparse(node),),
            )

    def _check_test_wrapper(self, module_node: object, path: Path, text: str) -> None:
        if not _is_dead_test_compat_wrapper(path, text):
            return
        self._add_module_message(
            "torghut-test-compat-wrapper",
            module_node=module_node,
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


def _exception_handler_name(node: ast.expr | None) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_dynamic_all_assignment(target: ast.AST, value: ast.AST) -> bool:
    return (
        isinstance(target, ast.Name)
        and target.id == "__all__"
        and _contains_globals_call(value)
    )


def _is_top_level_all_assignment(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.Assign):
        return any(_is_all_target(target) for target in statement.targets)
    return isinstance(statement, ast.AnnAssign) and _is_all_target(statement.target)


def _is_empty_all_assignment(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.Assign):
        value = (
            statement.value
            if any(_is_all_target(target) for target in statement.targets)
            else None
        )
    elif isinstance(statement, ast.AnnAssign) and _is_all_target(statement.target):
        value = statement.value
    else:
        return False
    if value is None:
        return False
    return isinstance(value, (ast.List, ast.Tuple)) and not value.elts


def _is_all_target(target: ast.AST) -> bool:
    return isinstance(target, ast.Name) and target.id == "__all__"


def _contains_globals_call(node: ast.AST) -> bool:
    for candidate in ast.walk(node):
        if (
            isinstance(candidate, ast.Call)
            and isinstance(candidate.func, ast.Name)
            and candidate.func.id == "globals"
        ):
            return True
    return False


def _is_compat_module_registry_target(target: ast.AST) -> bool:
    return isinstance(target, ast.Name) and target.id in {
        "__compat_part_modules__",
        "__compat_module_segments__",
    }


def _is_sys_modules_class_target(target: ast.AST) -> bool:
    return (
        isinstance(target, ast.Attribute)
        and target.attr == "__class__"
        and _is_sys_modules_subscript(target.value)
    )


def _is_sys_modules_replacement_target(target: ast.AST) -> bool:
    return _is_sys_modules_subscript(target)


def _is_sys_modules_subscript(target: ast.AST) -> bool:
    return (
        isinstance(target, ast.Subscript)
        and isinstance(target.value, ast.Attribute)
        and target.value.attr == "modules"
        and isinstance(target.value.value, ast.Name)
        and target.value.value.id in {"sys", "_sys"}
    )


def _is_globals_update_call(node: ast.Call) -> bool:
    return (
        isinstance(node.func, ast.Attribute)
        and node.func.attr == "update"
        and isinstance(node.func.value, ast.Call)
        and isinstance(node.func.value.func, ast.Name)
        and node.func.value.func.id == "globals"
    )


def _is_exec_call(node: ast.Call) -> bool:
    return isinstance(node.func, ast.Name) and node.func.id == "exec"


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
