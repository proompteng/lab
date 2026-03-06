#!/usr/bin/env python3
"""Validate Torghut migration-lineage policy for CI and release readiness."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from app.db import _parse_migration_graph

# Current graph is intentionally branched while merge migrations are in progress.
# Any new divergent graph shape must update this allowlist explicitly in the same change.
DEFAULT_ALLOWED_DIVERGENT_SIGNATURES = {
    'ac5a75f133e919f02b8064501a537fd3fc2580fa14d8ab6906edcf599ede1235',
}


def _parse_bool(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {'1', 'true', 'yes', 'on'}:
        return True
    if normalized in {'0', 'false', 'no', 'off'}:
        return False
    return default


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Validate migration DAG lineage policy and fail on unsafe topology changes.',
    )
    parser.add_argument(
        '--versions-dir',
        default='migrations/versions',
        help='Path to Alembic versions directory (default: migrations/versions).',
    )
    parser.add_argument(
        '--max-root-count',
        type=int,
        default=1,
        help='Maximum allowed migration root count before failure (default: 1).',
    )
    parser.add_argument(
        '--max-branch-count',
        type=int,
        default=int(os.getenv('TRADING_DB_SCHEMA_GRAPH_BRANCH_TOLERANCE', '1')),
        help='Maximum allowed migration branch/head count before divergence checks apply (default: env or 1).',
    )
    parser.add_argument(
        '--allow-branch-divergence',
        action='store_true',
        default=_parse_bool(
            os.getenv('TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS'),
            default=False,
        ),
        help='Allow branch-count divergence without requiring a signature allowlist.',
    )
    parser.add_argument(
        '--allow-signature',
        action='append',
        default=[],
        help='Additional schema graph signature allowed when branch count exceeds tolerance.',
    )
    return parser.parse_args()


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def main() -> int:
    args = _parse_args()
    versions_dir = Path(args.versions_dir)

    try:
        summary = _parse_migration_graph(versions_dir)
    except Exception as exc:  # pragma: no cover - defensive CLI handling
        print(f'migration_graph_check_failed: {exc}', file=sys.stderr)
        return 1

    heads = [str(item) for item in _as_list(summary.get('expected_migration_heads'))]
    roots = [str(item) for item in _as_list(summary.get('expected_migration_roots'))]
    branch_count = int(summary.get('expected_migration_branch_count') or len(heads))
    graph_signature = str(summary.get('expected_schema_graph_signature') or '')
    parent_forks = {
        str(parent): [str(child) for child in _as_list(children)]
        for parent, children in _as_dict(summary.get('expected_migration_parent_forks')).items()
    }
    duplicate_revisions = {
        str(revision): [str(path) for path in _as_list(paths)]
        for revision, paths in _as_dict(summary.get('expected_migration_duplicate_revisions')).items()
    }
    orphan_parents = [
        str(parent) for parent in _as_list(summary.get('expected_migration_orphan_parents'))
    ]

    allowed_signatures = set(DEFAULT_ALLOWED_DIVERGENT_SIGNATURES)
    allowed_signatures.update({signature for signature in args.allow_signature if signature})
    env_allowed_signatures = os.getenv('TRADING_DB_SCHEMA_GRAPH_ALLOWED_DIVERGENCE_SIGNATURES', '').strip()
    if env_allowed_signatures:
        allowed_signatures.update(
            signature.strip()
            for signature in env_allowed_signatures.split(',')
            if signature.strip()
        )

    errors: list[str] = []
    warnings: list[str] = []

    if duplicate_revisions:
        duplicates = ', '.join(sorted(duplicate_revisions))
        errors.append(f'duplicate migration revisions detected: {duplicates}')

    if orphan_parents:
        errors.append(f'orphan parent revisions detected: {", ".join(orphan_parents)}')

    root_count = len(roots)
    if root_count > args.max_root_count:
        root_message = (
            f'migration root count {root_count} exceeds allowed {args.max_root_count}'
        )
        if args.allow_branch_divergence or graph_signature in allowed_signatures:
            warnings.append(root_message + '; override acknowledged')
        else:
            errors.append(root_message)

    if branch_count > args.max_branch_count:
        branch_message = (
            f'migration branch count {branch_count} exceeds allowed {args.max_branch_count}'
        )
        if args.allow_branch_divergence:
            warnings.append(branch_message + '; TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true')
        elif graph_signature in allowed_signatures:
            warnings.append(branch_message + f'; allowlisted signature {graph_signature}')
        else:
            errors.append(
                branch_message
                + '; add --allow-signature <signature> (or update allowlist) in the same change if intentional'
            )

    output = {
        'ok': len(errors) == 0,
        'versions_dir': str(versions_dir),
        'schema_graph_signature': graph_signature,
        'heads': heads,
        'roots': roots,
        'branch_count': branch_count,
        'max_branch_count': args.max_branch_count,
        'max_root_count': args.max_root_count,
        'parent_forks': parent_forks,
        'duplicate_revisions': duplicate_revisions,
        'orphan_parents': orphan_parents,
        'warnings': warnings,
        'errors': errors,
    }
    print(json.dumps(output, indent=2, sort_keys=True))

    return 0 if len(errors) == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
