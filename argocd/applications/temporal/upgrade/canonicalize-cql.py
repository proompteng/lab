"""Hash nonempty SELECT JSON results consistently across bundled Python versions."""

from __future__ import print_function
import hashlib
import json
import sys

rows = []
for line in sys.stdin:
    line = line.strip()
    if line.startswith("{"):
        rows.append(json.dumps(json.loads(line), sort_keys=True, separators=(",", ":")))
if not rows:
    raise SystemExit("No JSON rows returned by the native Cassandra query")
print(hashlib.sha256(("\n".join(sorted(rows)) + "\n").encode("utf-8")).hexdigest())
