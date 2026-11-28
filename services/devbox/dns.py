#!/usr/bin/env python3
"""Apply only the committed devbox DNS record on the Pi-hole host."""

import argparse
import json
import pathlib
import subprocess
import tomllib

HOSTNAME = "codex-turin.k8s.proompteng.ai"


def reconcile(current, desired):
    entries = [entry for entry in desired if HOSTNAME in entry.split()[1:]]
    if len(entries) != 1 or len(entries[0].split()) != 2:
        raise ValueError("Expected one dedicated devbox DNS record")
    result = []
    for entry in current:
        fields = entry.split()
        aliases = [name for name in fields[1:] if name != HOSTNAME]
        if aliases:
            result.append(" ".join([fields[0], *aliases]))
    return [*result, entries[0]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path, help="Committed pihole.toml")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    config = pathlib.Path("/etc/pihole/pihole.toml")
    current = tomllib.loads(config.read_text())["dns"]["hosts"]
    desired = tomllib.loads(args.source.read_text())["dns"]["hosts"]
    hosts = reconcile(current, desired)
    if hosts != current:
        if not args.apply:
            raise SystemExit("Devbox DNS differs; use --apply on the Pi-hole host")
        subprocess.run(
            ["pihole-FTL", "--config", "dns.hosts", json.dumps(hosts)], check=True
        )
        subprocess.run(["systemctl", "restart", "pihole-FTL"], check=True)
    observed = tomllib.loads(config.read_text())["dns"]["hosts"]
    if observed != hosts:
        raise RuntimeError("Pi-hole did not retain the requested DNS records")
    print(next(entry for entry in hosts if HOSTNAME in entry.split()[1:]))


if __name__ == "__main__":
    main()
