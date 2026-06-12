"""Compatibility wiring for extracted Torghut API modules."""

from __future__ import annotations

import sys
import types
from collections.abc import Iterable, Mapping
from typing import Any, cast


class MainAttrProxy:
    """Lazy proxy to an attribute on app.main.

    Tests historically patch private app.main helpers. Extracted route modules
    keep resolving those helpers through app.main so those patches still affect
    endpoint behavior while the implementation lives in smaller modules.
    """

    def __init__(self, name: str):
        self._name = name

    def _target(self) -> Any:
        main_module = sys.modules.get("app.main")
        if main_module is None:
            raise RuntimeError("app.main is not loaded")
        return getattr(main_module, self._name)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._target()(*args, **kwargs)

    def __getattr__(self, item: str) -> Any:
        return getattr(self._target(), item)

    def __bool__(self) -> bool:
        return bool(self._target())

    def __str__(self) -> str:
        return str(self._target())

    def __repr__(self) -> str:
        return repr(self._target())

    def __int__(self) -> int:
        return int(self._target())

    def __float__(self) -> float:
        return float(self._target())

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter(self._target())

    def __len__(self) -> int:
        return len(self._target())

    def __getitem__(self, item: Any) -> Any:
        return self._target()[item]

    def __eq__(self, other: object) -> bool:
        return self._target() == other


def capture_module_exports(
    module_globals: dict[str, Any],
    names: Iterable[str],
) -> dict[str, Any]:
    exports = {name: module_globals[name] for name in names if name in module_globals}
    module_globals["_EXPORTED_SYMBOLS"] = exports
    return exports


def export_api_symbols(
    main_module: types.ModuleType,
    modules: Iterable[types.ModuleType],
) -> None:
    for module in modules:
        raw_exports = getattr(module, "_EXPORTED_SYMBOLS", {})
        if not isinstance(raw_exports, Mapping):
            continue
        exports = cast(Mapping[str, Any], raw_exports)
        for name, value in exports.items():
            setattr(main_module, name, value)


def install_main_compat_proxies(
    modules: Iterable[types.ModuleType],
    names: Iterable[str],
) -> None:
    proxy_names = tuple(dict.fromkeys(names))
    for module in modules:
        module_globals = vars(module)
        for name in proxy_names:
            if name == "router":
                continue
            module_globals[name] = MainAttrProxy(name)
