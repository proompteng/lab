from __future__ import annotations

# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false
# ruff: noqa: F401,F403,F405,F811,F821
from .source_segment_01 import SOURCE as _SOURCE_01
from .source_segment_02 import SOURCE as _SOURCE_02
from .source_segment_03 import SOURCE as _SOURCE_03
from .source_segment_04 import SOURCE as _SOURCE_04
from .source_segment_05 import SOURCE as _SOURCE_05
from .source_segment_06 import SOURCE as _SOURCE_06
from .source_segment_07 import SOURCE as _SOURCE_07
from .source_segment_08 import SOURCE as _SOURCE_08
from .source_segment_09 import SOURCE as _SOURCE_09
from .source_segment_10 import SOURCE as _SOURCE_10

__compat_source__ = "".join(
    [
        _SOURCE_01,
        _SOURCE_02,
        _SOURCE_03,
        _SOURCE_04,
        _SOURCE_05,
        _SOURCE_06,
        _SOURCE_07,
        _SOURCE_08,
        _SOURCE_09,
        _SOURCE_10,
    ]
)
exec(
    compile(
        __compat_source__,
        "scripts/run_whitepaper_autoresearch_profit_target.py",
        "exec",
    ),
    globals(),
)
__all__ = [name for name in globals() if not name.startswith("__")]
