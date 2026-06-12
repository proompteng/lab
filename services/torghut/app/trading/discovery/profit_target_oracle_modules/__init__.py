from __future__ import annotations

# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false
# ruff: noqa: F401,F403,F405,F811,F821
from .source_part_01 import SOURCE as _SOURCE_01
from .source_part_02 import SOURCE as _SOURCE_02

__compat_source__ = "".join([_SOURCE_01, _SOURCE_02])
__compat_exec_globals__ = globals()
__compat_exec_globals__["__package__"] = "app.trading.discovery"
exec(
    compile(__compat_source__, "app/trading/discovery/profit_target_oracle.py", "exec"),
    __compat_exec_globals__,
)
__all__ = [name for name in globals() if not name.startswith("__")]
