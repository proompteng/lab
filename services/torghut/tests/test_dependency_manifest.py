from __future__ import annotations

from pathlib import Path
import tomllib
from typing import Any, cast

from packaging.requirements import Requirement


def _pyproject() -> dict[str, Any]:
    pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
    return tomllib.loads(pyproject_path.read_text(encoding="utf-8"))


def _requirement_names(requirements: list[str]) -> set[str]:
    return {Requirement(requirement).name for requirement in requirements}


def test_runtime_dependencies_do_not_directly_own_openai_sdk() -> None:
    payload = _pyproject()
    runtime_dependencies = cast(list[str], payload["project"]["dependencies"])

    assert "openai" not in _requirement_names(runtime_dependencies)
    assert "dspy-ai" in _requirement_names(runtime_dependencies)


def test_dead_code_audit_tool_is_a_locked_dev_dependency() -> None:
    payload = _pyproject()
    optional_dependencies = cast(
        dict[str, list[str]], payload["project"]["optional-dependencies"]
    )

    assert "vulture" in _requirement_names(optional_dependencies["dev"])
    assert "vulture" in cast(dict[str, Any], payload["tool"])
