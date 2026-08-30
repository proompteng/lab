from __future__ import annotations

import ast
from pathlib import Path


TORGHUT_ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = TORGHUT_ROOT / "app"
HOT_PATHS = (
    APP_ROOT / "hyperliquid_execution",
    APP_ROOT / "trading" / "multifactor",
)
FORBIDDEN_IMPORT_FAMILIES = (
    "app.trading.discovery",
    "app.trading.runtime_window_import",
    "app.trading.llm",
    "app.trading.proof_floor",
    "app.trading.tigerbeetle",
    "app.trading.empirical",
    "autoresearch",
    "bounded_route",
    "empirical",
    "proof_floor",
    "promotion",
    "route_materialization",
    "runtime_window",
    "tigerbeetle",
    "whitepaper",
)


def test_multifactor_hot_path_does_not_import_legacy_authority_lanes() -> None:
    offenders: list[str] = []
    for root in HOT_PATHS:
        for path in root.rglob("*.py"):
            module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for imported in _imported_modules(module):
                for forbidden in FORBIDDEN_IMPORT_FAMILIES:
                    if forbidden in imported:
                        offenders.append(
                            f"{path.relative_to(TORGHUT_ROOT)} imports {imported}"
                        )

    assert offenders == []


def _imported_modules(module: ast.Module) -> list[str]:
    imported: list[str] = []
    for node in ast.walk(module):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            imported.append(node.module)
    return imported
