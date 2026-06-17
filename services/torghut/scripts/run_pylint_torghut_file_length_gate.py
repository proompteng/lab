"""Run Torghut's file-length gate while allowing extracted legacy source payloads."""

from __future__ import annotations

import argparse
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
_SOURCE_PAYLOAD_FILE_PREFIX = "source_" + "segment_"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        required=True,
        help="Base commit/ref used to identify legacy source-segment payloads.",
    )
    parser.add_argument("files", nargs="+", help="Paths to pass to Pylint")
    args = parser.parse_args(argv)

    extracted_paths = _base_extracted_source_paths(args.base)
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
    messages = _filter_legacy_extracted_messages(
        pylint_output.stdout,
        extracted_paths=extracted_paths,
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
) -> list[str]:
    messages: list[str] = []
    for line in output.splitlines():
        match = _PYLINT_MESSAGE_RE.match(line)
        if match is None:
            continue
        if match.group("path") in extracted_paths:
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


def _repo_root() -> Path:
    result = _run(["git", "rev-parse", "--show-toplevel"], check=True)
    return Path(result.stdout.strip())


if __name__ == "__main__":
    sys.exit(main())
