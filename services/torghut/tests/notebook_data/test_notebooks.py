from __future__ import annotations

from pathlib import Path

import nbformat
import pytest
from nbclient import NotebookClient
from scripts import generate_diagnostics_notebooks as notebook_generator

SERVICE_ROOT = Path(__file__).resolve().parents[2]
NOTEBOOK_ROOT = SERVICE_ROOT / "notebooks"
CANONICAL_NOTEBOOKS = (
    "00-system-flow.ipynb",
    "10-strategy-lifecycle.ipynb",
    "20-execution-evidence.ipynb",
    "30-capital-authority.ipynb",
)


def test_generator_writes_deterministic_output_free_notebooks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(notebook_generator, "NOTEBOOK_DIR", tmp_path)
    notebook_generator.main()
    first = {name: (tmp_path / name).read_bytes() for name in CANONICAL_NOTEBOOKS}
    notebook_generator.main()
    second = {name: (tmp_path / name).read_bytes() for name in CANONICAL_NOTEBOOKS}
    assert first == second

    for name in CANONICAL_NOTEBOOKS:
        notebook = nbformat.read(tmp_path / name, as_version=4)
        assert len({cell.id for cell in notebook.cells}) == len(notebook.cells)
        assert all(
            cell.execution_count is None and cell.outputs == []
            for cell in notebook.cells
            if cell.cell_type == "code"
        )


def test_committed_notebooks_are_valid_and_output_free() -> None:
    for name in CANONICAL_NOTEBOOKS:
        notebook = nbformat.read(NOTEBOOK_ROOT / name, as_version=4)
        nbformat.validate(notebook)
        assert notebook.cells[0].cell_type == "markdown"
        assert "TL;DR" in notebook.cells[0].source
        for cell in notebook.cells:
            if cell.cell_type == "code":
                assert cell.execution_count is None
                assert cell.outputs == []


@pytest.mark.parametrize("name", CANONICAL_NOTEBOOKS)
def test_notebook_executes_top_to_bottom_with_explicit_fixtures(
    name: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TORGHUT_NOTEBOOK_DATA_MODE", "fixture")
    notebook = nbformat.read(NOTEBOOK_ROOT / name, as_version=4)
    client = NotebookClient(
        notebook,
        timeout=180,
        kernel_name="python3",
        resources={"metadata": {"path": str(SERVICE_ROOT)}},
    )
    executed = client.execute()
    rendered = "\n".join(
        str(output.get("data", {}).get("text/html", ""))
        for cell in executed.cells
        if cell.cell_type == "code"
        for output in cell.outputs
        if output.output_type in {"display_data", "execute_result"}
    )
    assert "FIXTURE MODE" in rendered
    assert all(
        output.output_type != "error"
        for cell in executed.cells
        if cell.cell_type == "code"
        for output in cell.outputs
    )


@pytest.mark.parametrize("name", CANONICAL_NOTEBOOKS)
def test_notebook_renders_explicit_unavailable_states_without_tracebacks(
    name: str,
) -> None:
    notebook = nbformat.read(NOTEBOOK_ROOT / name, as_version=4)
    notebook.cells.insert(
        2,
        nbformat.v4.new_code_cell(
            """
from app.notebook_data.adapters import NotebookDataError

class UnavailableAdapter:
    mode = 'live'

    def postgres(self, *args, **kwargs):
        raise NotebookDataError('PostgreSQL fixture outage')

    def clickhouse(self, *args, **kwargs):
        raise NotebookDataError('ClickHouse fixture outage')

    def status(self, *args, **kwargs):
        raise NotebookDataError('status fixture outage')

adapter = UnavailableAdapter()
""".strip()
        ),
    )
    client = NotebookClient(
        notebook,
        timeout=180,
        kernel_name="python3",
        resources={"metadata": {"path": str(SERVICE_ROOT)}},
    )
    executed = client.execute()
    outputs = [
        output
        for cell in executed.cells
        if cell.cell_type == "code"
        for output in cell.outputs
    ]
    assert all(output.output_type != "error" for output in outputs)
    rendered = "\n".join(
        str(output.get("data", {}).get("text/html", ""))
        for output in outputs
        if output.output_type in {"display_data", "execute_result"}
    )
    assert "unavailable" in rendered.lower()
