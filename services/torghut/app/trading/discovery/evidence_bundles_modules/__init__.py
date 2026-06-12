# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
from __future__ import annotations

from importlib import import_module as __compat_import_module__
import sys as __compat_sys__
import types as __compat_types__

__compat_part_modules__: list[__compat_types__.ModuleType] = []


class __CompatModule__(__compat_types__.ModuleType):
    def __setattr__(self, name: str, value: object) -> None:
        super().__setattr__(name, value)
        for module in __compat_part_modules__:
            module.__dict__[name] = value


def __compat_export__(module: __compat_types__.ModuleType) -> None:
    for name, value in module.__dict__.items():
        if name.startswith("__"):
            continue
        globals()[name] = value


__compat_module__ = __compat_import_module__(f"{__name__}.part_01_statements_12")
__compat_part_modules__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_part_modules__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(
    f"{__name__}.part_02_runtime_ledger_lineage_handoff_blockers"
)
__compat_part_modules__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_part_modules__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(
    f"{__name__}.part_03_evidence_bundle_from_frontier_candidate"
)
__compat_part_modules__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_part_modules__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(
    f"{__name__}.part_04_implementation_risk_backtest_stability_blo"
)
__compat_part_modules__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_part_modules__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_module__ = __compat_import_module__(
    f"{__name__}.part_05_evidence_bundle_blockers"
)
__compat_part_modules__.append(__compat_module__)
__compat_export__(__compat_module__)
for __compat_loaded_module__ in __compat_part_modules__:
    __compat_loaded_module__.__dict__.update(
        {name: value for name, value in globals().items() if not name.startswith("__")}
    )

__compat_sys__.modules[__name__].__class__ = __CompatModule__
__all__ = [
    name
    for name in globals()
    if not name.startswith("__") and not name.startswith("_CompatModule")
]
del __compat_module__
