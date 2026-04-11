"""Export helpers for MLX autoresearch diagnostics notebooks."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from app.trading.discovery.mlx_features import MlxCandidateDescriptor
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.mlx_proposal_models import ProposalScore


def _write_json(path: Path, payload: Mapping[str, Any]) -> Path:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding='utf-8')
    return path


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> Path:
    path.write_text(
        '\n'.join(json.dumps(row, sort_keys=True) for row in rows) + ('\n' if rows else ''),
        encoding='utf-8',
    )
    return path


def write_mlx_notebook_exports(
    *,
    run_root: Path,
    manifest: MlxSnapshotManifest,
    descriptors: Sequence[MlxCandidateDescriptor],
    proposal_scores: Sequence[ProposalScore],
) -> dict[str, str]:
    manifest_path = run_root / 'mlx-snapshot-manifest.json'
    descriptors_path = run_root / 'mlx-candidate-descriptors.jsonl'
    proposals_path = run_root / 'mlx-proposal-scores.jsonl'
    _write_json(manifest_path, manifest.to_payload())
    _write_jsonl(descriptors_path, [item.to_payload() for item in descriptors])
    _write_jsonl(proposals_path, [item.to_payload() for item in proposal_scores])
    return {
        'manifest_path': str(manifest_path),
        'descriptors_path': str(descriptors_path),
        'proposal_scores_path': str(proposals_path),
    }
