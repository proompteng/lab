"""Compatibility wiring for extracted Torghut API modules."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def capture_module_exports(
    module_globals: dict[str, Any],
    names: Iterable[str],
) -> dict[str, Any]:
    exports = {name: module_globals[name] for name in names if name in module_globals}
    module_globals["_EXPORTED_SYMBOLS"] = exports
    return exports
