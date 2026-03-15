#!/usr/bin/env python3
"""Assemble a canonical Torghut production-readiness proof bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


_BUNDLE_SCHEMA_VERSION = 'torghut.production-readiness-bundle.v1'


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise SystemExit(f'json_object_required:{path}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(payload), indent=2, sort_keys=True), encoding='utf-8')


def _sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _canonicalize_payload(
    *,
    payload: Mapping[str, Any],
    artifact_name: str,
    image_digest: str,
    proof_timestamp: str,
    run_id: str | None,
    workflow_name: str | None,
    proof_id: str | None,
    broker_mode: str,
) -> dict[str, Any]:
    canonical = dict(payload)
    canonical.setdefault('schema_version', artifact_name)
    canonical.setdefault('image_digest', image_digest)
    canonical.setdefault('proof_timestamp', proof_timestamp)
    if run_id:
        canonical.setdefault('run_id', run_id)
    if workflow_name:
        canonical.setdefault('workflow_name', workflow_name)
    if proof_id:
        canonical.setdefault('proof_id', proof_id)
    canonical.setdefault('broker_mode', broker_mode)
    canonical.setdefault('bundle_artifact', artifact_name)
    return canonical


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--image-digest', required=True)
    parser.add_argument('--proof-timestamp', default=_utc_now())
    parser.add_argument('--run-id', default=None)
    parser.add_argument('--workflow-name', default=None)
    parser.add_argument('--proof-id', default=None)
    parser.add_argument('--broker-mode', default='paper')
    parser.add_argument('--simulation-proof', type=Path, required=True)
    parser.add_argument('--broker-proof', type=Path, required=True)
    parser.add_argument('--profitability-proof', type=Path, required=True)
    parser.add_argument('--model-risk-evidence', type=Path, required=True)
    parser.add_argument('--session-ready', type=Path, required=True)
    parser.add_argument('--performance', type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = _parser().parse_args(argv)

    artifact_inputs = {
        'simulation-proof.json': args.simulation_proof,
        'broker-proof.json': args.broker_proof,
        'profitability-proof.json': args.profitability_proof,
        'model-risk-evidence.json': args.model_risk_evidence,
        'session-ready.json': args.session_ready,
        'performance.json': args.performance,
    }

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    artifact_manifest: dict[str, Any] = {}

    for artifact_name, source_path in artifact_inputs.items():
        payload = _load_json_object(source_path)
        canonical = _canonicalize_payload(
            payload=payload,
            artifact_name=artifact_name.removesuffix('.json'),
            image_digest=args.image_digest,
            proof_timestamp=args.proof_timestamp,
            run_id=args.run_id,
            workflow_name=args.workflow_name,
            proof_id=args.proof_id or args.run_id,
            broker_mode=args.broker_mode,
        )
        destination = output_dir / artifact_name
        _write_json(destination, canonical)
        artifact_manifest[artifact_name] = {
            'source_path': str(source_path),
            'bundle_path': str(destination),
            'sha256': _sha256(destination),
        }

    bundle_manifest = {
        'schema_version': _BUNDLE_SCHEMA_VERSION,
        'image_digest': args.image_digest,
        'proof_timestamp': args.proof_timestamp,
        'run_id': args.run_id,
        'workflow_name': args.workflow_name,
        'proof_id': args.proof_id or args.run_id,
        'broker_mode': args.broker_mode,
        'artifacts': artifact_manifest,
    }
    manifest_path = output_dir / 'bundle-manifest.json'
    _write_json(manifest_path, bundle_manifest)
    print(json.dumps(bundle_manifest, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
