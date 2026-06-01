#!/usr/bin/env python3
"""Run advisory GPU/CPU sleeve simulation preview artifacts."""

from __future__ import annotations

import argparse
import json
import logging
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from app.trading.discovery.candidate_specs import candidate_spec_from_payload
from app.trading.discovery.replay_tape import load_replay_tape
from app.trading.discovery.sleeve_simulation_preview import (
    build_sleeve_simulation_preview,
)


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build preview-only sleeve simulation artifacts from replay tapes.",
    )
    parser.add_argument("--candidate-specs", required=True, type=Path)
    parser.add_argument("--replay-tape-path", required=True, type=Path)
    parser.add_argument("--replay-tape-manifest", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--preview-scores", type=Path)
    parser.add_argument(
        "--backend",
        default="auto",
        choices=("cpu", "numpy", "auto", "numba-cuda"),
        help=(
            "Backend for preview-only sleeve simulation. Explicit numba-cuda "
            "fails closed when unavailable; auto may fall back to CPU."
        ),
    )
    parser.add_argument("--top-k", default=24, type=int)
    parser.add_argument("--min-returns-per-path", default=2, type=int)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    logging.getLogger("numba.cuda.cudadrv.driver").setLevel(logging.WARNING)
    args = _parse_args(argv)
    specs = [
        candidate_spec_from_payload(_mapping(payload))
        for payload in _read_jsonl(args.candidate_specs)
    ]
    tape = load_replay_tape(
        args.replay_tape_path,
        manifest_path=args.replay_tape_manifest,
        verify_digest=True,
    )
    panel = build_sleeve_simulation_preview(
        specs=specs,
        rows=tape.rows,
        replay_tape_manifest=tape.manifest,
        preview_scores=_read_preview_scores(args.preview_scores),
        top_k=int(args.top_k),
        backend_preference=str(args.backend),
        min_returns_per_path=int(args.min_returns_per_path),
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output_dir / "sleeve-simulation-preview-manifest.json"
    rows_path = args.output_dir / "sleeve-simulation-preview-rows.jsonl"
    manifest_path.write_text(
        json.dumps(panel.to_payload(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    rows_path.write_text(
        "".join(
            json.dumps(row.to_payload(), sort_keys=True) + "\n"
            for row in panel.rows
        ),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "status": "preview_only",
                "promotion_proof": False,
                "manifest": str(manifest_path),
                "rows": str(rows_path),
                "selected_candidate_spec_count": len(panel.selected_candidate_spec_ids),
                "selected_candidate_spec_ids": list(panel.selected_candidate_spec_ids),
                "replay_tape_digest": tape.manifest.content_sha256,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def _read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    payloads: list[Mapping[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        payloads.append(_mapping(json.loads(stripped)))
    return payloads


def _read_preview_scores(path: Path | None) -> dict[str, float]:
    if path is None:
        return {}
    scores: dict[str, float] = {}
    for payload in _read_jsonl(path):
        candidate_spec_id = str(payload.get("candidate_spec_id") or "")
        if not candidate_spec_id:
            continue
        try:
            scores[candidate_spec_id] = float(payload.get("preview_score"))
        except (TypeError, ValueError):
            continue
    return scores


def _mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    raise ValueError("json_object_required")


if __name__ == "__main__":
    raise SystemExit(main())
