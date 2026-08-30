from __future__ import annotations

from importlib.machinery import SourceFileLoader
import importlib.util
from pathlib import Path
from types import ModuleType

_MIGRATIONS_ROOT = Path(__file__).resolve().parents[1] / "migrations" / "versions"


def migration_path(filename: str) -> Path:
    if Path(filename).name != filename:
        raise AssertionError(f"migration_filename_must_be_basename:{filename}")

    path = _MIGRATIONS_ROOT / filename
    if not path.is_file():
        raise AssertionError(f"migration_not_found:{filename}:expected_path={path}")
    return path


def load_migration_module(filename: str) -> ModuleType:
    path = migration_path(filename)

    revision = filename.partition("_")[0]
    module_name = f"torghut_migration_{revision}"
    loader = SourceFileLoader(module_name, str(path))
    spec = importlib.util.spec_from_loader(module_name, loader)
    if spec is None:
        raise AssertionError(f"failed_to_load_migration:{filename}")

    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module
