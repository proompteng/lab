"""Regenerate the four-shard timing input from a successful CI artifact set."""

import json
import math
import pathlib
import subprocess
import sys
import xml.etree.ElementTree as ET

service = pathlib.Path(__file__).resolve().parent.parent
expected = json.loads(
    subprocess.check_output(
        ["bun", str(service / "tools/test-postgres.ts"), "--list"], text=True
    )
)
if len(sys.argv) < 2:
    raise SystemExit(
        "Usage: python3 tools/test-postgres-timings.py <downloaded-CI-artifact-directory>..."
    )
measured = {}
for directory in sys.argv[1:]:
    for path in pathlib.Path(directory).rglob("postgres-results.xml"):
        report = ET.parse(path).getroot()
        if int(report.get("failures", "0")) or int(report.get("errors", "0")):
            raise ValueError(f"Cannot balance shards from a failed run: {path}")
        weights = json.loads(
            (path.parent / "tools/ci-postgres-timings.json").read_text()
        )
        if weights["version"] != 1:
            raise ValueError(f"Unsupported timing format: {path}")
        files = {
            suite.get("file", "").removeprefix("./").removeprefix("services/bayn/")
            for suite in report.iter("testsuite")
        }
        for file in files & set(expected):
            if file in measured:
                raise ValueError(f"Test file executed in multiple shards: {file}")
            elapsed = weights["files"][file]
            if (
                isinstance(elapsed, bool)
                or not isinstance(elapsed, (int, float))
                or not math.isfinite(elapsed)
                or elapsed < 0
            ):
                raise ValueError(f"Invalid measured duration: {file}")
            measured[file] = elapsed
if set(measured) != set(expected):
    raise ValueError(
        f"Missing successful file measurements: {sorted(set(expected) - set(measured))}"
    )
target = service / "tools/ci-postgres-timings.json"
target.write_text(
    json.dumps(
        {"version": 1, "files": {file: measured[file] for file in expected}}, indent=2
    )
    + "\n"
)
print(
    f"Updated {len(measured)} file weights from successful, non-overlapping shard reports"
)
