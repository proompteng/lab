from __future__ import annotations

from pathlib import Path

import nbformat
from nbclient import NotebookClient

SERVICE_ROOT = Path(__file__).resolve().parents[2]
NOTEBOOK_PATH = (
    SERVICE_ROOT / "notebooks" / "40-transformer-math-from-first-principles.ipynb"
)


def test_committed_transformer_notebook_is_valid_and_pairs_math_with_geometry() -> None:
    notebook = nbformat.read(NOTEBOOK_PATH, as_version=4)
    nbformat.validate(notebook)
    assert len({cell.id for cell in notebook.cells}) == len(notebook.cells)
    assert notebook.cells[0].cell_type == "markdown"
    assert "TL;DR" in notebook.cells[0].source
    assert "geometric" in notebook.cells[0].source.lower()
    source = "\n".join(cell.source for cell in notebook.cells).lower()
    markdown_control_characters = [
        (cell.id, offset, ord(character))
        for cell in notebook.cells
        if cell.cell_type == "markdown"
        for offset, character in enumerate(cell.source)
        if ord(character) < 32 and character not in "\n\r"
    ]
    assert markdown_control_characters == []
    for concept in (
        "scaled dot-product attention",
        "probability simplex",
        "convex combination",
        "rope",
        "parallelogram",
        "layernorm",
        "swiglu",
        "cross-entropy",
        "kv-cache",
        "flashattention",
    ):
        assert concept in source
    for cell in notebook.cells:
        if cell.cell_type == "code":
            assert cell.execution_count is None
            assert cell.outputs == []

    numbered_sections = [
        index
        for index, cell in enumerate(notebook.cells)
        if cell.cell_type == "markdown"
        and cell.source.startswith("## ")
        and cell.source.removeprefix("## ").split(".", maxsplit=1)[0].isdigit()
    ]
    assert len(numbered_sections) == 30
    for section_index in numbered_sections:
        geometry_cell = notebook.cells[section_index + 1]
        assert geometry_cell.cell_type == "code"
        assert any(
            marker in geometry_cell.source
            for marker in ("show_", "go.Figure", "display(")
        )


def test_transformer_notebook_executes_top_to_bottom() -> None:
    notebook = nbformat.read(NOTEBOOK_PATH, as_version=4)
    client = NotebookClient(
        notebook,
        timeout=240,
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
    assert outputs
    assert all(output.output_type != "error" for output in outputs)
