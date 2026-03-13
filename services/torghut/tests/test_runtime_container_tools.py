from __future__ import annotations

from pathlib import Path


def test_runtime_image_installs_simulation_compression_tools() -> None:
    dockerfile = Path(__file__).resolve().parent.parent / 'Dockerfile'
    contents = dockerfile.read_text(encoding='utf-8')

    assert 'pigz' in contents
    assert 'zstd' in contents
