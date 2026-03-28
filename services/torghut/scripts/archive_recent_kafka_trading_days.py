#!/usr/bin/env python3
"""Archive Kafka-backed historical simulation runs into immutable replay bundles."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping

from app.trading.profitability_archive import archive_historical_simulation_run
from scripts.start_historical_simulation import _build_resources, _load_manifest

_SERVICE_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_ROOT = Path(__file__).resolve().parent
_START_SIMULATION_SCRIPT = _SCRIPTS_ROOT / 'start_historical_simulation.py'
_ANALYZE_SIMULATION_SCRIPT = _SCRIPTS_ROOT / 'analyze_historical_simulation.py'


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-root', required=True, help='Archive root for immutable replay bundles.')
    parser.add_argument('--run-dir', action='append', default=[], help='Existing historical simulation run directory.')
    parser.add_argument(
        '--scan-root',
        action='append',
        default=[],
        help='Directory to scan recursively for historical simulation run directories.',
    )
    parser.add_argument(
        '--manifest',
        action='append',
        default=[],
        help='Historical simulation manifest to execute, analyze, and archive.',
    )
    parser.add_argument(
        '--run-id-prefix',
        default='archive',
        help='Prefix for manifest-driven simulation run ids.',
    )
    parser.add_argument(
        '--topic-retention-ms',
        action='append',
        default=[],
        help='Topic retention mapping in topic=milliseconds format.',
    )
    parser.add_argument(
        '--persist-dataset-snapshots',
        action='store_true',
        help='Persist archived replay bundles into vnext_dataset_snapshots.',
    )
    parser.add_argument(
        '--python-bin',
        default=sys.executable,
        help='Python interpreter used when executing historical simulation manifests.',
    )
    parser.add_argument('--json', action='store_true')
    return parser.parse_args()


def _parse_topic_retention_ms(raw_values: Iterable[str]) -> dict[str, int]:
    topic_retention_ms_by_topic: dict[str, int] = {}
    for raw_value in raw_values:
        topic, separator, value = raw_value.partition('=')
        topic_name = topic.strip()
        if separator != '=' or not topic_name:
            raise RuntimeError(f'invalid_topic_retention_mapping:{raw_value}')
        try:
            topic_retention_ms_by_topic[topic_name] = int(value.strip())
        except ValueError as exc:
            raise RuntimeError(f'invalid_topic_retention_ms:{raw_value}') from exc
    return topic_retention_ms_by_topic


def _canonical_paths(paths: Iterable[Path]) -> list[Path]:
    deduped: dict[Path, Path] = {}
    for path in paths:
        resolved = path.resolve()
        deduped[resolved] = resolved
    return sorted(deduped.values())


def _discover_run_dirs(scan_roots: Iterable[Path]) -> list[Path]:
    run_dirs: list[Path] = []
    for scan_root in scan_roots:
        for marker in sorted(scan_root.rglob('run-manifest.json')):
            run_dir = marker.parent
            if (run_dir / 'replay-report.json').exists() and (run_dir / 'report' / 'simulation-report.json').exists():
                run_dirs.append(run_dir)
    return _canonical_paths(run_dirs)


def _normalized_manifest_run_id(*, manifest_path: Path, manifest: Mapping[str, Any], run_id_prefix: str) -> str:
    raw_base = str(manifest.get('dataset_id') or manifest_path.stem).strip()
    normalized = re.sub(r'[^a-z0-9]+', '-', raw_base.lower()).strip('-')
    normalized = normalized or 'historical-simulation'
    return f'{run_id_prefix.strip() or "archive"}-{normalized}'[:63]


def _run_subprocess(command: list[str]) -> None:
    subprocess.run(
        command,
        cwd=_SERVICE_ROOT,
        check=True,
    )


def _execute_manifest_and_collect_run_dir(
    *,
    manifest_path: Path,
    run_id_prefix: str,
    python_bin: str,
) -> Path:
    manifest = _load_manifest(manifest_path)
    run_id = _normalized_manifest_run_id(
        manifest_path=manifest_path,
        manifest=manifest,
        run_id_prefix=run_id_prefix,
    )
    _run_subprocess(
        [
            python_bin,
            str(_START_SIMULATION_SCRIPT),
            '--run-id',
            run_id,
            '--dataset-manifest',
            str(manifest_path),
            '--json',
        ]
    )
    _run_subprocess(
        [
            python_bin,
            str(_ANALYZE_SIMULATION_SCRIPT),
            '--run-id',
            run_id,
            '--dataset-manifest',
            str(manifest_path),
            '--json',
        ]
    )
    resources = _build_resources(run_id, manifest)
    return (resources.output_root / resources.run_token).resolve()


def archive_recent_kafka_trading_days(
    *,
    archive_root: Path,
    run_dirs: Iterable[Path] = (),
    scan_roots: Iterable[Path] = (),
    manifest_paths: Iterable[Path] = (),
    run_id_prefix: str = 'archive',
    topic_retention_ms_by_topic: Mapping[str, int] | None = None,
    persist_dataset_snapshots: bool = False,
    python_bin: str = sys.executable,
) -> dict[str, Any]:
    archive_root = archive_root.resolve()
    explicit_run_dirs = _canonical_paths(run_dirs)
    discovered_run_dirs = _discover_run_dirs(scan_roots)
    manifest_run_dirs = [
        _execute_manifest_and_collect_run_dir(
            manifest_path=manifest_path.resolve(),
            run_id_prefix=run_id_prefix,
            python_bin=python_bin,
        )
        for manifest_path in manifest_paths
    ]
    run_dirs_to_archive = _canonical_paths([*explicit_run_dirs, *discovered_run_dirs, *manifest_run_dirs])

    session = None
    if persist_dataset_snapshots:
        from app.db import SessionLocal

        session = SessionLocal()
    try:
        results = [
            archive_historical_simulation_run(
                run_dir=run_dir,
                archive_root=archive_root,
                topic_retention_ms_by_topic=topic_retention_ms_by_topic,
                session=session,
            )
            for run_dir in run_dirs_to_archive
        ]
        if session is not None:
            session.commit()
    finally:
        if session is not None:
            session.close()

    return {
        'archive_root': str(archive_root),
        'run_dir_count': len(run_dirs_to_archive),
        'archived_count': len(results),
        'persist_dataset_snapshots': persist_dataset_snapshots,
        'topic_retention_ms_by_topic': {
            str(topic): int(value) for topic, value in (topic_retention_ms_by_topic or {}).items()
        },
        'results': results,
    }


def main() -> int:
    args = _parse_args()
    summary = archive_recent_kafka_trading_days(
        archive_root=Path(args.archive_root),
        run_dirs=[Path(path) for path in args.run_dir],
        scan_roots=[Path(path) for path in args.scan_root],
        manifest_paths=[Path(path) for path in args.manifest],
        run_id_prefix=args.run_id_prefix,
        topic_retention_ms_by_topic=_parse_topic_retention_ms(args.topic_retention_ms),
        persist_dataset_snapshots=args.persist_dataset_snapshots,
        python_bin=args.python_bin,
    )
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(json.dumps(summary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
