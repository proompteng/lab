#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.trading.discovery.rapids_tape_features import build_rapids_tape_feature_panel
from app.trading.discovery.replay_tape import load_replay_tape


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a RAPIDS/cuDF or pandas tape feature panel from a manifest-verified replay tape.",
    )
    parser.add_argument("--replay-tape-path", type=Path, required=True)
    parser.add_argument("--replay-tape-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rows-output", type=Path, required=True)
    parser.add_argument(
        "--backend",
        choices=("pandas", "auto", "rapids-cudf"),
        default="rapids-cudf",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    tape = load_replay_tape(
        args.replay_tape_path,
        manifest_path=args.replay_tape_manifest,
    )
    panel = build_rapids_tape_feature_panel(
        rows=tape.rows,
        replay_tape_manifest=tape.manifest,
        backend_preference=args.backend,
    )
    payload = panel.to_payload()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.rows_output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    row_payloads = payload.get("rows")
    rows = row_payloads if isinstance(row_payloads, list) else []
    args.rows_output.write_text(
        "".join(
            json.dumps(row, sort_keys=True) + "\n"
            for row in rows
            if isinstance(row, dict)
        ),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
