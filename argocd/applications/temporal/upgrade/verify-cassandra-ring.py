"""Require the original host and 256 unique tokens before comparing native rings."""

from __future__ import print_function
import hashlib
import json
import sys


def ring_digest(lines):
    rows = [json.loads(line.strip()) for line in lines if line.strip().startswith("{")]
    if (
        len(rows) != 1
        or rows[0].get("host_id") != "49cbb919-5b4c-4489-bab3-ec01a67297fa"
    ):
        raise ValueError("native ring must contain the original source host")
    tokens = rows[0].get("tokens")
    if not isinstance(tokens, list) or len(tokens) != 256:
        raise ValueError("native ring must contain exactly 256 tokens")
    values = [int(token) for token in tokens]
    if len(set(values)) != 256 or any(
        value < -(2**63) or value >= 2**63 for value in values
    ):
        raise ValueError("native ring contains invalid or duplicate tokens")
    canonical = json.dumps(sorted(values), separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


if __name__ == "__main__":
    print(ring_digest(sys.stdin))
