from __future__ import annotations

# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false
# ruff: noqa: F401,F403,F405,F811,F821
import logging as __compat_logging__

from .source_part_01 import SOURCE as _SOURCE_01
from .source_part_02 import SOURCE as _SOURCE_02
from .source_part_03 import SOURCE as _SOURCE_03

__compat_source__ = "".join([_SOURCE_01, _SOURCE_02, _SOURCE_03])
__compat_exec_globals__ = globals()
__compat_exec_globals__["__package__"] = "scripts"
exec(
    compile(__compat_source__, "scripts/local_intraday_tsmom_replay.py", "exec"),
    __compat_exec_globals__,
)
logger = __compat_logging__.getLogger(__name__.removesuffix("_modules"))
for __compat_loaded_module__ in globals().get("__compat_part_modules__", ()):
    __compat_loaded_module__.__dict__["logger"] = logger
__all__ = [name for name in globals() if not name.startswith("__")]
