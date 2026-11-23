#!/usr/bin/env python3
"""Reject required integration files that did not execute a successful case."""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def verify(report: Path, expected: list[Path]) -> None:
    root = ET.parse(report).getroot()
    if root.tag != "testsuites":
        raise ValueError("Expected a Bun JUnit testsuites report")
    suites = root.findall("testsuite")
    if not suites:
        raise ValueError("Required integration run reported no test files")
    reported = set()
    for suite in suites:
        source = suite.get("file")
        if not source:
            raise ValueError("Required integration file is missing its report identity")
        path = Path(source).resolve()
        if path in reported:
            raise ValueError(f"Required integration file reported multiple times: {source}")
        reported.add(path)
        cases = list(suite.iter("testcase"))
        if any(
            case.find("failure") is not None or case.find("error") is not None
            for case in cases
        ):
            raise ValueError(f"Required integration failed: {source}")
        if not any(case.find("skipped") is None for case in cases):
            raise ValueError(
                f"Required integration executed no successful cases: {source}"
            )
    expected_paths = {source.resolve() for source in expected}
    missing = expected_paths - reported
    if missing:
        raise ValueError(
            f"Required integration files absent from report: {sorted(map(str, missing))}"
        )
    unexpected = reported - expected_paths if expected else set()
    if unexpected:
        raise ValueError(
            f"Unexpected integration files in report: {sorted(map(str, unexpected))}"
        )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(
            "Usage: verify-integration-results.py <junit.xml> [required-file ...]"
        )
    verify(Path(sys.argv[1]), [Path(source) for source in sys.argv[2:]])
