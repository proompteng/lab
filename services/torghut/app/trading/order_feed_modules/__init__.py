# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
from __future__ import annotations

from importlib import import_module as __compat_import_module__
import logging as __compat_logging__
import sys as __compat_sys__
import types as __compat_types__

__compat_module_segments__: list[__compat_types__.ModuleType] = []


class __CompatModule__(__compat_types__.ModuleType):
    def __setattr__(self, name: str, value: object) -> None:
        super().__setattr__(name, value)
        for module in __compat_module_segments__:
            module.__dict__[name] = value


def __compat_export__(module: __compat_types__.ModuleType) -> None:
    for name, value in module.__dict__.items():
        if name.startswith("__"):
            continue
        globals()[name] = value


__compat_module__ = __compat_import_module__(f"{__name__}.shared_context")
__compat_module_segments__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_module_segments__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(f"{__name__}.classify_source_window_drop")
__compat_module_segments__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_module_segments__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(f"{__name__}.normalize_order_feed_record")
__compat_module_segments__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_module_segments__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(
    f"{__name__}.repair_order_feed_execution_links"
)
__compat_module_segments__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_module_segments__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(
    f"{__name__}.resolve_execution_linkage_for_identity"
)
__compat_module_segments__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_module_segments__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(f"{__name__}.flatten_poll_records")
__compat_module_segments__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_module_segments__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_sys__.modules[__name__].__class__ = __CompatModule__
logger = __compat_logging__.getLogger(__name__.removesuffix("_modules"))
for __compat_loaded_module__ in globals().get("__compat_module_segments__", ()):
    __compat_loaded_module__.__dict__["logger"] = logger
__all__ = [
    name
    for name in globals()
    if not name.startswith("__") and not name.startswith("_CompatModule")
]
del __compat_module__
