from pathlib import Path

from app.trading.autonomy.retention import prune_autonomy_run_directories


def test_prunes_only_old_timestamped_run_directories(tmp_path: Path) -> None:
    run_names = [
        "20260713T000000",
        "20260713T000500",
        "20260713T001000",
        "20260713T001500",
    ]
    for run_name in run_names:
        run_directory = tmp_path / run_name
        run_directory.mkdir()
        (run_directory / "signals.json").write_text("[]", encoding="utf-8")

    notes = tmp_path / "notes"
    notes.mkdir()
    incidents = tmp_path / "rollback-incidents"
    incidents.mkdir()

    removed = prune_autonomy_run_directories(tmp_path, retention_runs=2)

    assert [path.name for path in removed] == run_names[:2]
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "20260713T001000",
        "20260713T001500",
        "notes",
        "rollback-incidents",
    ]


def test_retains_at_least_one_run_directory(tmp_path: Path) -> None:
    for run_name in ["20260713T000000", "20260713T000500"]:
        (tmp_path / run_name).mkdir()

    removed = prune_autonomy_run_directories(tmp_path, retention_runs=0)

    assert [path.name for path in removed] == ["20260713T000000"]
    assert (tmp_path / "20260713T000500").is_dir()
