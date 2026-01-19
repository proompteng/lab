#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


def patch_file(path: Path) -> bool:
    lines = path.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    changed = False
    skip_next_preserve = False

    for idx, line in enumerate(lines):
        if line.strip() == "openAPIV3Schema:":
            output.append(line)
            skip_next_preserve = True
            continue

        if skip_next_preserve:
            skip_next_preserve = False
            if line.strip() == "x-kubernetes-preserve-unknown-fields: false":
                changed = True
                continue

        output.append(line)
    if changed:
        path.write_text("\n".join(output) + "\n", encoding="utf-8")
    return changed


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-crds.py <crds-dir>", file=sys.stderr)
        return 2
    crd_dir = Path(sys.argv[1])
    if not crd_dir.exists():
        print(f"CRD dir not found: {crd_dir}", file=sys.stderr)
        return 2

    patched = 0
    for path in sorted(crd_dir.glob("*.yaml")):
        if patch_file(path):
            patched += 1

    print(f"patched {patched} CRD(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
