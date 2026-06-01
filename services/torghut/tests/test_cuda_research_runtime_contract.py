from __future__ import annotations

from pathlib import Path
import tomllib
from typing import Any, cast

from unittest import TestCase


class TestCudaResearchRuntimeContract(TestCase):
    def test_cuda_research_extra_uses_explicit_pytorch_cu128_index(self) -> None:
        pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
        payload = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))

        optional_dependencies = cast(
            dict[str, list[str]], payload["project"]["optional-dependencies"]
        )
        self.assertIn(
            "torch==2.11.0+cu128 ; sys_platform == 'win32' or sys_platform == 'linux'",
            optional_dependencies["cuda-research"],
        )

        tool_uv = cast(dict[str, Any], payload["tool"]["uv"])
        indexes = cast(list[dict[str, Any]], tool_uv["index"])
        pytorch_cu128 = next(
            item for item in indexes if item.get("name") == "pytorch-cu128"
        )
        self.assertEqual(pytorch_cu128["url"], "https://download.pytorch.org/whl/cu128")
        self.assertEqual(pytorch_cu128["explicit"], True)

        sources = cast(dict[str, list[dict[str, str]]], tool_uv["sources"])
        self.assertEqual(
            sources["torch"],
            [
                {
                    "index": "pytorch-cu128",
                    "extra": "cuda-research",
                    "marker": "sys_platform == 'win32' or sys_platform == 'linux'",
                }
            ],
        )
