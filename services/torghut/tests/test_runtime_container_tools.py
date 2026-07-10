from __future__ import annotations

from pathlib import Path


def test_runtime_image_installs_simulation_compression_tools() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    image_definition = repo_root / "nix/images/torghut.nix"
    contents = image_definition.read_text(encoding="utf-8")

    assert "pkgs.kubectl" in contents
    assert "pigz" in contents
    assert "zstd" in contents
