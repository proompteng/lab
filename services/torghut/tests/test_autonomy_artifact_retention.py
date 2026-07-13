from pathlib import Path

from app.trading.autonomy.retention import (
    mark_autonomy_owned_root,
    prune_autonomy_run_directories,
)


def test_prunes_only_old_timestamped_run_directories(tmp_path: Path) -> None:
    artifact_root = tmp_path / "autonomy"
    artifact_root.mkdir()
    run_names = [
        "20260713T000000",
        "20260713T000500",
        "20260713T001000",
        "20260713T001500",
    ]
    for run_name in run_names:
        run_directory = artifact_root / run_name
        run_directory.mkdir()
        (run_directory / "signals.json").write_text("[]", encoding="utf-8")

    notes = artifact_root / "notes"
    notes.mkdir()
    incidents = artifact_root / "rollback-incidents"
    incidents.mkdir()

    removed = prune_autonomy_run_directories(artifact_root, retention_runs=2)

    assert [path.name for path in removed] == run_names[:2]
    assert sorted(path.name for path in artifact_root.iterdir()) == [
        "20260713T001000",
        "20260713T001500",
        "notes",
        "rollback-incidents",
    ]


def test_retains_at_least_one_run_directory(tmp_path: Path) -> None:
    artifact_root = tmp_path / "autonomy"
    artifact_root.mkdir()
    for run_name in ["20260713T000000", "20260713T000500"]:
        (artifact_root / run_name).mkdir()

    removed = prune_autonomy_run_directories(artifact_root, retention_runs=0)

    assert [path.name for path in removed] == ["20260713T000000"]
    assert (artifact_root / "20260713T000500").is_dir()


def test_preserves_active_run_when_its_timestamp_is_older(tmp_path: Path) -> None:
    artifact_root = tmp_path / "autonomy"
    artifact_root.mkdir()
    active_run = artifact_root / "20260712T235500"
    active_run.mkdir()
    for run_name in ["20260713T000000", "20260713T000500", "20260713T001000"]:
        (artifact_root / run_name).mkdir()

    removed = prune_autonomy_run_directories(
        artifact_root,
        retention_runs=2,
        active_run_directory=active_run,
    )

    assert [path.name for path in removed] == ["20260713T000000", "20260713T000500"]
    assert sorted(path.name for path in artifact_root.iterdir()) == [
        "20260712T235500",
        "20260713T001000",
    ]


def test_refuses_to_prune_unmarked_shared_root(tmp_path: Path) -> None:
    for run_name in ["20260713T000000", "20260713T000500"]:
        (tmp_path / run_name).mkdir()

    removed = prune_autonomy_run_directories(tmp_path, retention_runs=1)

    assert removed == ()
    assert (tmp_path / "20260713T000000").is_dir()
    assert (tmp_path / "20260713T000500").is_dir()


def test_prunes_the_default_torghut_autonomy_root(tmp_path: Path) -> None:
    artifact_root = tmp_path / "torghut-autonomy"
    artifact_root.mkdir()
    for run_name in ["20260713T000000", "20260713T000500"]:
        (artifact_root / run_name).mkdir()

    removed = prune_autonomy_run_directories(artifact_root, retention_runs=1)

    assert [path.name for path in removed] == ["20260713T000000"]
    assert (artifact_root / "20260713T000500").is_dir()


def test_prunes_explicitly_marked_custom_root(tmp_path: Path) -> None:
    artifact_root = tmp_path / "custom-autonomy-artifacts"
    artifact_root.mkdir()
    mark_autonomy_owned_root(artifact_root)
    for run_name in ["20260713T000000", "20260713T000500"]:
        (artifact_root / run_name).mkdir()

    removed = prune_autonomy_run_directories(artifact_root, retention_runs=1)

    assert [path.name for path in removed] == ["20260713T000000"]
    assert (artifact_root / "20260713T000500").is_dir()
