#!/usr/bin/env python3
"""Train the whitepaper autoresearch MLX proposal ranker from artifact JSONL files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping, cast

from app.trading.discovery.candidate_specs import (
    CandidateSpec,
    candidate_spec_from_payload,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_payload,
)
from app.trading.discovery.mlx_training_data import (
    build_mlx_training_rows,
    rank_training_rows,
    train_mlx_ranker,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train an MLX autoresearch ranker artifact."
    )
    parser.add_argument("--candidate-specs", type=Path, required=True)
    parser.add_argument("--evidence-bundles", type=Path, required=True)
    parser.add_argument("--model-output", type=Path, required=True)
    parser.add_argument("--scores-output", type=Path, required=True)
    parser.add_argument("--backend-preference", default="mlx")
    return parser.parse_args()


def _read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        if isinstance(payload, Mapping):
            rows.append(cast(Mapping[str, Any], payload))
    return rows


def train_from_artifacts(
    *,
    candidate_specs_path: Path,
    evidence_bundles_path: Path,
    backend_preference: str = "mlx",
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    candidate_specs: list[CandidateSpec] = [
        candidate_spec_from_payload(row) for row in _read_jsonl(candidate_specs_path)
    ]
    evidence_bundles: list[CandidateEvidenceBundle] = [
        evidence_bundle_from_payload(row) for row in _read_jsonl(evidence_bundles_path)
    ]
    training_rows = build_mlx_training_rows(
        candidate_specs=candidate_specs,
        evidence_bundles=evidence_bundles,
    )
    model = train_mlx_ranker(training_rows, backend_preference=backend_preference)
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    scores = [
        {
            **item.to_payload(),
            "proposal_score": item.score,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in rank_training_rows(model=model, rows=training_rows)
    ]
    return model.to_payload(), scores


def main() -> int:
    args = _parse_args()
    model_payload, scores = train_from_artifacts(
        candidate_specs_path=args.candidate_specs,
        evidence_bundles_path=args.evidence_bundles,
        backend_preference=str(args.backend_preference),
    )
    args.model_output.parent.mkdir(parents=True, exist_ok=True)
    args.scores_output.parent.mkdir(parents=True, exist_ok=True)
    args.model_output.write_text(
        json.dumps(model_payload, indent=2, sort_keys=True), encoding="utf-8"
    )
    args.scores_output.write_text(
        "\n".join(json.dumps(row, sort_keys=True) for row in scores)
        + ("\n" if scores else ""),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "status": "ok",
                "model_id": model_payload["model_id"],
                "backend": model_payload["backend"],
                "row_count": model_payload["row_count"],
                "model_output": str(args.model_output),
                "scores_output": str(args.scores_output),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
