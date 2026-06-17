from __future__ import annotations

import io
from pathlib import Path
from typing import NamedTuple

from pylint.lint import Run
from pylint.reporters.text import TextReporter

from scripts import pylint_torghut_quality as quality

PLUGIN_ENABLES = ",".join(
    (
        "torghut-generated-split-filename",
        "torghut-dynamic-globals-reexport",
        "torghut-compat-module-wrapper",
        "torghut-compat-module-registry",
        "torghut-module-class-mutation",
        "torghut-module-replacement",
        "torghut-private-pyright-suppression",
        "torghut-file-pyright-suppression",
        "torghut-type-ignore",
        "torghut-file-ruff-noqa",
        "torghut-blanket-pylint-disable",
        "torghut-dynamic-attribute-hook",
        "torghut-dynamic-all",
        "torghut-wildcard-import",
        "torghut-custom-module-class",
        "torghut-test-compat-wrapper",
    )
)


def test_torghut_pylint_quality_plugin_accepts_normal_modules(
    tmp_path: Path,
) -> None:
    module_path = tmp_path / "semantic_module.py"
    module_path.write_text(
        "\n".join(
            (
                "from __future__ import annotations",
                "",
                "__all__ = ['answer']",
                "",
                "def answer() -> int:",
                "    return 42",
                "",
            )
        ),
        encoding="utf-8",
    )

    result = _run_quality_pylint(module_path)

    assert result.returncode == 0, result.output
    assert "torghut-" not in result.output


def test_torghut_pylint_quality_plugin_rejects_refactor_slop(
    tmp_path: Path,
) -> None:
    dynamic_reexport = "globals()" + ".update(other.__dict__)"
    module_replacement = "_sys." + "modules[__name__] = other"
    module_class_mutation = "_sys." + "modules[__name__].__class__ = Facade"
    dynamic_exports = "__all__ = [name for name in " + "globals() if name]"
    type_suppression = "# type:" + " ignore[assignment]"
    private_usage_suppression = "# pyright: " + "report" + "PrivateUsage" + "=false"
    compat_class = "class " + "Compat" + "Module:"
    compat_registry = "__compat_" + "par" + "t_modules__ = []"
    module_path = tmp_path / ("par" + "t_01_generated.py")
    module_path.write_text(
        "\n".join(
            (
                "from __future__ import annotations",
                "",
                "import sys as _sys",
                "from types import ModuleType",
                "from math import *",
                "",
                "# pyright: reportUnknownMemberType=false",
                private_usage_suppression,
                "# ruff: noqa: F401,F403",
                "# pylint: disable=too-many-lines",
                f"answer = 1  {type_suppression}",
                "",
                "class Facade(ModuleType):",
                "    pass",
                "",
                compat_class,
                "    pass",
                "",
                compat_registry,
                "",
                "def __getattr__(name: str) -> object:",
                "    raise AttributeError(name)",
                "",
                dynamic_exports,
                dynamic_reexport,
                module_replacement,
                module_class_mutation,
                "",
            )
        ),
        encoding="utf-8",
    )

    result = _run_quality_pylint(module_path)

    assert result.returncode != 0
    expected_symbols = {
        "torghut-generated-split-filename",
        "torghut-dynamic-globals-reexport",
        "torghut-compat-module-wrapper",
        "torghut-compat-module-registry",
        "torghut-module-class-mutation",
        "torghut-module-replacement",
        "torghut-private-pyright-suppression",
        "torghut-file-pyright-suppression",
        "torghut-type-ignore",
        "torghut-file-ruff-noqa",
        "torghut-blanket-pylint-disable",
        "torghut-dynamic-attribute-hook",
        "torghut-dynamic-all",
        "torghut-wildcard-import",
        "torghut-custom-module-class",
    }
    output = result.output
    missing = sorted(symbol for symbol in expected_symbols if symbol not in output)
    assert not missing, output


def test_torghut_pylint_quality_plugin_rejects_test_compat_wrappers(
    tmp_path: Path,
) -> None:
    wrapper_path = tmp_path / "test_old_wrapper.py"
    wrapper_path.write_text(
        "\n".join(
            (
                "from __future__ import annotations",
                "",
                "__test__ = False",
                "from tests.real_split.test_case import TestCase",
                "",
            )
        ),
        encoding="utf-8",
    )
    empty_path = tmp_path / "test_empty_wrapper.py"
    empty_path.write_text(
        "\n".join(
            (
                "from __future__ import annotations",
                "",
                "# ruff: noqa: F401,F403,F405",
                "",
            )
        ),
        encoding="utf-8",
    )

    wrapper_result = _run_quality_pylint(wrapper_path)
    empty_result = _run_quality_pylint(empty_path)

    assert wrapper_result.returncode != 0
    assert "torghut-test-compat-wrapper" in wrapper_result.output
    assert empty_result.returncode != 0
    assert "torghut-test-compat-wrapper" in empty_result.output


def test_torghut_pylint_quality_test_wrapper_helper_rejects_only_dead_wrappers(
    tmp_path: Path,
) -> None:
    is_dead_wrapper = getattr(quality, "_is_dead_test_compat_wrapper")

    assert not is_dead_wrapper(tmp_path / "test_invalid.py", "def broken(:\n")
    assert is_dead_wrapper(
        tmp_path / "test_docstring_wrapper.py",
        "\n".join(
            (
                '"""compatibility wrapper."""',
                "from __future__ import annotations",
                "__test__ = False",
                "from tests.real_split.test_case import TestCase",
                "",
            )
        ),
    )
    assert not is_dead_wrapper(
        tmp_path / "test_real_module.py",
        "\n".join(
            (
                "from __future__ import annotations",
                "__test__ = False",
                "VALUE = 1",
                "",
            )
        ),
    )
    assert not is_dead_wrapper(
        tmp_path / "test_nonempty_suppression.py",
        "\n".join(
            (
                "from __future__ import annotations",
                "# ruff: noqa: F401",
                "VALUE = 1",
                "",
            )
        ),
    )


class PylintResult(NamedTuple):
    returncode: int
    output: str


def _run_quality_pylint(module_path: Path) -> PylintResult:
    output = io.StringIO()
    run = Run(
        [
            "--load-plugins=scripts.pylint_torghut_quality",
            "--disable=all",
            f"--enable={PLUGIN_ENABLES}",
            "--score=n",
            "--reports=n",
            "--msg-template={symbol}:{line}:{msg}",
            str(module_path),
        ],
        reporter=TextReporter(output),
        exit=False,
    )
    return PylintResult(run.linter.msg_status, output.getvalue())
