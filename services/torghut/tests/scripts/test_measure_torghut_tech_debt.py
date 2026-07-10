from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from scripts.measure_torghut_tech_debt import (
    PylintMeasurementError,
    format_json,
    format_markdown,
    measure_torghut_debt,
    measure_pylint_design,
    parse_pylint_design_output,
    ratchet_violations,
    ratcheted_metrics,
)


def test_measurement_counts_files_thresholds_markers_and_ast_debt(
    tmp_path: Path,
) -> None:
    app_path = tmp_path / "app" / "hot_path.py"
    app_path.parent.mkdir()
    app_path.write_text(
        "\n".join(
            (
                "from __future__ import annotations",
                "from typing import Any",
                "",
                "def long_function() -> object:",
                *(["    value = 1"] * 98),
                "    try:",
                "        return value",
                "    except Exception:",
                "        return Any",
            )
        ),
        encoding="utf-8",
    )

    measurement = measure_torghut_debt(
        root=tmp_path,
        include_pylint_design=False,
    )

    assert measurement["total"] == {"files": 1, "lines": 106}
    assert measurement["roots"] == {"app": {"files": 1, "lines": 106}}
    assert measurement["production"] == {
        "paths": ["app", "scripts"],
        "files": 1,
        "lines": 106,
    }
    threshold_counts = measurement["threshold_counts"]
    assert threshold_counts["functions_ge_100"] == 1
    assert threshold_counts["files_ge_1000"] == 0
    assert "files_ge_500" not in threshold_counts
    markers = measurement["markers"]
    assert markers["typing_any_import"]["total"] == 1
    assert markers["broad_exception"]["total"] == 1


def test_ratchet_violations_report_only_debt_metric_increases(tmp_path: Path) -> None:
    app_path = tmp_path / "app" / "example.py"
    app_path.parent.mkdir()
    app_path.write_text(
        "\n".join(
            (
                "from __future__ import annotations",
                "",
                "def short_function() -> int:",
                "    return 1",
            )
        ),
        encoding="utf-8",
    )
    baseline = measure_torghut_debt(root=tmp_path, include_pylint_design=False)
    app_path.write_text(
        "\n".join(
            (
                "from __future__ import annotations",
                "from typing import Any",
                "def short_function() -> object:",
                "    return Any",
            )
        ),
        encoding="utf-8",
    )
    current = measure_torghut_debt(root=tmp_path, include_pylint_design=False)

    violations = ratchet_violations(current, baseline)

    assert [violation.metric for violation in violations] == [
        "markers.typing_any_import.total"
    ]
    assert violations[0].baseline == 0
    assert violations[0].current == 1


def test_ratchet_metrics_include_production_budgets_and_debt_counters() -> None:
    measurement = {
        "production": {"files": 6, "lines": 120},
        "threshold_counts": {"functions_ge_100": 2},
        "markers": {"broad_exception": {"total": 3}},
        "pylint_design": {"total": 4, "by_code": {"R0915": 5}},
    }

    assert ratcheted_metrics(measurement) == {
        "markers.broad_exception.total": 3,
        "pylint_design.by_code.R0915": 5,
        "pylint_design.total": 4,
        "production.files": 6,
        "production.lines": 120,
        "threshold_counts.functions_ge_100": 2,
    }


def test_v1_baseline_derives_production_budgets_from_roots() -> None:
    measurement = {
        "schema_version": "torghut.tech-debt-measurement.v1",
        "roots": {
            "app": {"files": 2, "lines": 20},
            "scripts": {"files": 3, "lines": 30},
            "tests": {"files": 100, "lines": 1000},
        },
    }

    assert ratcheted_metrics(measurement) == {
        "production.files": 5,
        "production.lines": 50,
    }


def test_ratchet_rejects_production_growth_hidden_below_file_thresholds() -> None:
    baseline = {
        "schema_version": "torghut.tech-debt-measurement.v1",
        "roots": {
            "app": {"files": 2, "lines": 20},
            "scripts": {"files": 3, "lines": 30},
        },
    }
    current = {
        "schema_version": "torghut.tech-debt-measurement.v2",
        "production": {"files": 6, "lines": 60},
    }

    violations = ratchet_violations(current, baseline)

    assert [violation.metric for violation in violations] == [
        "production.files",
        "production.lines",
    ]


def test_pylint_measurement_accepts_refactor_findings_exit_status(
    tmp_path: Path,
) -> None:
    (tmp_path / "app").mkdir()
    result = subprocess.CompletedProcess(
        args=[],
        returncode=8,
        stdout="app/example.py:12:0: R0915: Too many statements (too-many-statements)\n",
    )

    with patch("scripts.measure_torghut_tech_debt.subprocess.run", return_value=result):
        measurement = measure_pylint_design(tmp_path, paths=("app",))

    assert measurement["total"] == 1


def test_pylint_measurement_fails_on_execution_error(tmp_path: Path) -> None:
    (tmp_path / "app").mkdir()
    result = subprocess.CompletedProcess(
        args=[],
        returncode=1,
        stdout="/usr/bin/python: No module named pylint\n",
    )

    with (
        patch("scripts.measure_torghut_tech_debt.subprocess.run", return_value=result),
        pytest.raises(PylintMeasurementError, match="exited with status 1"),
    ):
        measure_pylint_design(tmp_path, paths=("app",))


def test_pylint_measurement_fails_when_process_cannot_start(tmp_path: Path) -> None:
    (tmp_path / "app").mkdir()

    with (
        patch(
            "scripts.measure_torghut_tech_debt.subprocess.run",
            side_effect=FileNotFoundError("python missing"),
        ),
        pytest.raises(PylintMeasurementError, match="unable to start Pylint"),
    ):
        measure_pylint_design(tmp_path, paths=("app",))


def test_parse_pylint_design_output_groups_known_design_codes() -> None:
    output = "\n".join(
        (
            "************* Module app.example",
            "app/example.py:12:0: R0915: Too many statements (too-many-statements)",
            "app/example.py:20:0: R0914: Too many local variables (too-many-locals)",
            "app/other.py:5:0: C0114: Missing module docstring (missing-module-docstring)",
        )
    )

    parsed = parse_pylint_design_output(output)

    assert parsed["total"] == 2
    assert parsed["by_code"]["R0915"] == 1
    assert parsed["by_code"]["R0914"] == 1
    assert parsed["top_files"] == [{"path": "app/example.py", "count": 2}]


def test_json_output_is_deterministic() -> None:
    measurement = {
        "schema_version": "test",
        "total": {"lines": 2, "files": 1},
        "threshold_counts": {"functions_ge_100": 0},
        "markers": {},
        "pylint_design": {"total": 0},
    }

    rendered = format_json(measurement)

    assert rendered == format_json(json.loads(rendered))
    assert rendered.splitlines()[1].strip().startswith('"markers"')


def test_markdown_output_contains_operator_summary() -> None:
    measurement = {
        "total": {"files": 1, "lines": 2},
        "threshold_counts": {"functions_ge_100": 0},
        "markers": {"broad_exception": {"total": 0}},
        "pylint_design": {"total": 0},
    }

    rendered = format_markdown(measurement)

    assert "# Torghut Tech Debt Measurement" in rendered
    assert "- Python files: 1" in rendered
    assert "- `broad_exception`: 0" in rendered
