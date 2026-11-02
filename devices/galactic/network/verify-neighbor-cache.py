#!/usr/bin/env python3
"""Read host neighbor limits and reject new overflow events during a bounded sample."""

import argparse
import json
import subprocess
import sys
import time


EXPECTED = [4096, 8192, 16384]
KUBECTL = ["kubectl", "--context", "galactic-lan", "-n", "kube-system"]
COUNTERS = ("table_fulls", "unresolved_discards", "forced_gc_runs")


def parse_stats(text):
    lines = text.splitlines()
    columns = lines[0].split()
    rows = [line.split() for line in lines[1:]]
    if not rows or any(len(row) != len(columns) for row in rows):
        raise ValueError("invalid arp_cache rows")
    values = [dict(zip(columns, (int(value, 16) for value in row))) for row in rows]
    return {
        "entries": values[0]["entries"],
        **{key: sum(row[key] for row in values) for key in COUNTERS},
    }


def check(before, after):
    if before["boot_id"] != after["boot_id"]:
        raise ValueError("host rebooted between samples")
    deltas = {key: after[key] - before[key] for key in COUNTERS}
    if any(delta < 0 for delta in deltas.values()):
        raise ValueError("neighbor counters reset between samples")
    failures = []
    if before["thresholds"] != EXPECTED or after["thresholds"] != EXPECTED:
        failures.append("neighbor limits differ from 4096/8192/16384")
    if deltas["table_fulls"]:
        failures.append("new neighbor table-full events")
    return {"before": before, "after": after, "increases": deltas, "failures": failures}


def run(args):
    return subprocess.check_output(KUBECTL + args, text=True, timeout=30)


def sample(pods):
    result = {}
    for node, pod in pods.items():
        lines = run(
            ["exec", pod, "-c", "kube-flannel", "--", "cat"]
            + [f"/proc/sys/net/ipv4/neigh/default/gc_thresh{i}" for i in (1, 2, 3)]
            + ["/proc/sys/kernel/random/boot_id", "/proc/net/stat/arp_cache"]
        ).splitlines()
        result[node] = {
            "thresholds": [int(value) for value in lines[:3]],
            "boot_id": lines[3],
            **parse_stats("\n".join(lines[4:])),
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--seconds", type=int, default=30, help="sample interval, 1–60 seconds"
    )
    args = parser.parse_args()
    if not 1 <= args.seconds <= 60:
        parser.error("--seconds must be between 1 and 60")
    nodes = json.loads(run(["get", "nodes", "-o", "json"]))["items"]
    items = json.loads(
        run(["get", "pods", "-l", "k8s-app=flannel,tier=node", "-o", "json"])
    )["items"]
    pods = {}
    for node in nodes:
        name = node["metadata"]["name"]
        matches = [
            p
            for p in items
            if p["spec"].get("nodeName") == name
            and p["spec"].get("hostNetwork") is True
            and p["status"].get("phase") == "Running"
            and not p["metadata"].get("deletionTimestamp")
        ]
        if len(matches) != 1:
            raise ValueError(f"expected one running host-network Flannel pod on {name}")
        pods[name] = matches[0]["metadata"]["name"]
    if not pods:
        raise ValueError("no nodes found")
    before = sample(pods)
    time.sleep(args.seconds)
    after = sample(pods)
    results = {node: check(before[node], after[node]) for node in pods}
    print(json.dumps(results, indent=2))
    return int(any(row["failures"] for row in results.values()))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        subprocess.SubprocessError,
        ValueError,
        KeyError,
        IndexError,
        OSError,
    ) as error:
        print(f"UNKNOWN: {error}", file=sys.stderr)
        sys.exit(2)
