"""Bounded retention for scheduler-owned autonomy run artifacts."""

import re
import shutil
import tempfile
from pathlib import Path

_RUN_DIRECTORY_PATTERN = re.compile(r"^\d{8}T\d{6}$")
_AUTONOMY_ROOT_MARKER = ".torghut-autonomy-root"


def mark_autonomy_owned_root(artifact_root: Path) -> None:
    """Mark an explicitly resolved artifact root as scheduler-owned."""
    resolved_root = artifact_root.resolve()
    system_temp_root = Path(tempfile.gettempdir()).resolve()
    unsafe_roots = {
        Path(resolved_root.anchor),
        Path.home().resolve(),
        system_temp_root,
        system_temp_root / "torghut",
    }
    if resolved_root in unsafe_roots:
        raise ValueError(f"unsafe_autonomy_artifact_root:{resolved_root}")
    (resolved_root / _AUTONOMY_ROOT_MARKER).touch(exist_ok=True)


def _is_autonomy_owned_root(artifact_root: Path) -> bool:
    return (
        artifact_root.name in {"autonomy", "torghut-autonomy"}
        or (artifact_root / _AUTONOMY_ROOT_MARKER).is_file()
    )


def prune_autonomy_run_directories(
    artifact_root: Path,
    *,
    retention_runs: int,
    active_run_directory: Path | None = None,
) -> tuple[Path, ...]:
    """Remove old timestamped run directories while preserving non-run evidence."""
    retain = max(1, int(retention_runs))
    if not artifact_root.exists() or not _is_autonomy_owned_root(artifact_root):
        return ()

    protected_run = (
        active_run_directory
        if active_run_directory is not None
        and active_run_directory.parent == artifact_root
        and active_run_directory.is_dir()
        and not active_run_directory.is_symlink()
        and _RUN_DIRECTORY_PATTERN.fullmatch(active_run_directory.name)
        else None
    )

    run_directories = sorted(
        (
            child
            for child in artifact_root.iterdir()
            if child.is_dir()
            and not child.is_symlink()
            and _RUN_DIRECTORY_PATTERN.fullmatch(child.name)
            and child != protected_run
        ),
        key=lambda child: child.name,
        reverse=True,
    )
    retained_other_runs = max(0, retain - (1 if protected_run is not None else 0))
    removed: list[Path] = []
    for run_directory in reversed(run_directories[retained_other_runs:]):
        shutil.rmtree(run_directory)
        removed.append(run_directory)
    return tuple(removed)
