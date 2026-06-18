"""Run the repo-wide Torghut structural Pylint gate."""

from __future__ import annotations

import argparse
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

DEFAULT_PATHS = ("app", "scripts", "tests", "migrations")
STRICT_STRUCTURAL_RULES = (
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
    "torghut-wildcard-ruff-noqa",
    "torghut-blanket-pylint-disable",
    "torghut-dynamic-attribute-hook",
    "torghut-dynamic-all",
    "torghut-wildcard-import",
    "torghut-custom-module-class",
    "torghut-test-compat-wrapper",
    "torghut-source-string-execution",
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--paths",
        nargs="+",
        default=DEFAULT_PATHS,
        help="Torghut-relative files or directories to scan.",
    )
    parser.add_argument(
        "--enable",
        default=",".join(STRICT_STRUCTURAL_RULES),
        help="Comma-separated Pylint structural rules to enable.",
    )
    parser.add_argument(
        "--load-plugins",
        default="scripts.pylint_torghut_quality",
        help="Comma-separated Pylint plugins to load, or an empty string.",
    )
    args = parser.parse_args(argv)

    scan_paths = _existing_paths(args.paths)
    if not scan_paths:
        print("No Torghut Python paths exist for structural gate.")
        return 0

    result = _run(build_pylint_command(args.enable, args.load_plugins, scan_paths))
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode != 0:
        return result.returncode
    print("No Torghut structural Pylint violations.")
    return 0


def build_pylint_command(
    enable: str, load_plugins: str, paths: Sequence[str]
) -> list[str]:
    command = [sys.executable, "-m", "pylint"]
    if load_plugins:
        command.append(f"--load-plugins={load_plugins}")
    command.extend(("--disable=all", f"--enable={enable}", "--score=n", *paths))
    return command


def _existing_paths(paths: Sequence[str]) -> list[str]:
    return [path for path in paths if Path(path).exists()]


def _run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


if __name__ == "__main__":
    sys.exit(main())
