#!/usr/bin/env python3
"""Build deterministic DSPy training/evaluation dataset artifacts."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from app.db import SessionLocal
from app.trading.llm.dspy_compile.dataset import (
    DEFAULT_SAMPLING_SEED,
    build_dspy_dataset_artifacts,
)


def _parse_window_end(raw: str) -> datetime:
    normalized = raw.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("window_end_requires_timezone")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repository", required=True, help="Repository slug (owner/name)."
    )
    parser.add_argument("--base", required=True, help="Base branch name.")
    parser.add_argument("--head", required=True, help="Head branch name.")
    parser.add_argument(
        "--artifact-path",
        required=True,
        type=Path,
        help="Directory where dspy-dataset*.json artifacts are written.",
    )
    parser.add_argument(
        "--dataset-window",
        required=True,
        help="ISO8601 duration window (for example P30D).",
    )
    parser.add_argument(
        "--universe-ref",
        required=True,
        help="Universe selector reference (for example torghut:equity:enabled).",
    )
    parser.add_argument(
        "--sampling-seed",
        default=DEFAULT_SAMPLING_SEED,
        help="Deterministic split seed (default: torghut-dspy-dataset-seed-v1).",
    )
    parser.add_argument(
        "--window-end",
        default="",
        help="Optional ISO timestamp anchor for datasetWindow (UTC recommended).",
    )
    parser.add_argument(
        "--source-ref",
        action="append",
        default=[],
        help="Additional reproducibility source reference (repeatable).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    window_end = _parse_window_end(args.window_end) if args.window_end else None

    with SessionLocal() as session:
        result = build_dspy_dataset_artifacts(
            session,
            repository=args.repository,
            base=args.base,
            head=args.head,
            artifact_path=args.artifact_path,
            dataset_window=args.dataset_window,
            universe_ref=args.universe_ref,
            source_refs=args.source_ref,
            sampling_seed=args.sampling_seed,
            window_end=window_end,
        )

    summary = {
        "ok": True,
        "datasetHash": result.dataset_hash,
        "totalRows": result.total_rows,
        "rowCountsBySplit": result.row_counts_by_split,
        "datasetPath": str(result.dataset_path),
        "metadataPath": str(result.metadata_path),
    }
    print(json.dumps(summary, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    print(f"dataset_hash={result.dataset_hash}")
    print(
        "row_counts_by_split="
        + json.dumps(
            result.row_counts_by_split,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
