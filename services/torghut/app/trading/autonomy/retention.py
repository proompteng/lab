"""Bounded retention for scheduler-owned autonomy run artifacts."""

import re
import shutil
from pathlib import Path

_RUN_DIRECTORY_PATTERN = re.compile(r"^\d{8}T\d{6}$")


def prune_autonomy_run_directories(
    artifact_root: Path,
    *,
    retention_runs: int,
) -> tuple[Path, ...]:
    """Remove old timestamped run directories while preserving non-run evidence."""
    retain = max(1, int(retention_runs))
    if not artifact_root.exists():
        return ()

    run_directories = sorted(
        (
            child
            for child in artifact_root.iterdir()
            if child.is_dir()
            and not child.is_symlink()
            and _RUN_DIRECTORY_PATTERN.fullmatch(child.name)
        ),
        key=lambda child: child.name,
        reverse=True,
    )
    removed: list[Path] = []
    for run_directory in reversed(run_directories[retain:]):
        shutil.rmtree(run_directory)
        removed.append(run_directory)
    return tuple(removed)
