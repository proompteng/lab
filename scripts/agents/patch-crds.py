#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ARGO_CRD_SYNC_WAVE_LINE = '    argocd.argoproj.io/sync-wave: "-10"'


def ensure_argocd_crd_sync_wave(lines: list[str]) -> tuple[list[str], bool]:
    """Keep CRD schema upgrades in an Argo wave before CR instances."""
    for index, line in enumerate(lines):
        if line.strip().startswith("argocd.argoproj.io/sync-wave:"):
            if line == ARGO_CRD_SYNC_WAVE_LINE:
                return lines, False
            updated = list(lines)
            updated[index] = ARGO_CRD_SYNC_WAVE_LINE
            return updated, True

    try:
        metadata_index = next(index for index, line in enumerate(lines) if line == "metadata:")
    except StopIteration:
        return lines, False

    annotations_index = None
    for index in range(metadata_index + 1, len(lines)):
        line = lines[index]
        if line and not line.startswith(" "):
            break
        if line == "  annotations:":
            annotations_index = index
            break

    updated = list(lines)
    if annotations_index is not None:
        updated.insert(annotations_index + 1, ARGO_CRD_SYNC_WAVE_LINE)
    else:
        updated[metadata_index + 1:metadata_index + 1] = ["  annotations:", ARGO_CRD_SYNC_WAVE_LINE]
    return updated, True


def patch_file(path: Path) -> bool:
    lines = path.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    changed = False

    for line in lines:
        if line.strip() == "x-kubernetes-preserve-unknown-fields: false":
            changed = True
            continue
        output.append(line)
    output, sync_wave_changed = ensure_argocd_crd_sync_wave(output)
    changed = changed or sync_wave_changed
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
