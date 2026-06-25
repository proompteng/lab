"""Run Torghut's file-length gate."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

_PYLINT_MESSAGE_RE = re.compile(
    r"^(?P<path>[^:]+):(?P<line>\d+):(?P<column>\d+): "
    r"(?P<code>[A-Z]\d+): "
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        required=True,
        help="Diff base kept for CI command compatibility.",
    )
    parser.add_argument("files", nargs="+", help="Paths to pass to Pylint")
    args = parser.parse_args(argv)

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
    messages = _filter_file_length_messages(
        pylint_output.stdout,
    )
    if messages:
        print("Pylint file-length violations:")
        for message in messages:
            print(message)
        return 16
    print("No blocking Pylint file-length violations.")
    return 0


def _filter_file_length_messages(
    output: str,
) -> list[str]:
    messages: list[str] = []
    for line in output.splitlines():
        match = _PYLINT_MESSAGE_RE.match(line)
        if match is None:
            continue
        if match.group("code") != "C0302":
            continue
        messages.append(line)
    return messages


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


if __name__ == "__main__":
    sys.exit(main())
