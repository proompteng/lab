from __future__ import annotations

# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false
# ruff: noqa: F401,F403,F405,F811,F821
from .source_part_01 import SOURCE as _SOURCE_01
from .source_part_02 import SOURCE as _SOURCE_02
from .source_part_03 import SOURCE as _SOURCE_03
from .source_part_04 import SOURCE as _SOURCE_04
from .source_part_05 import SOURCE as _SOURCE_05
from .source_part_06 import SOURCE as _SOURCE_06

__compat_source__ = "".join(
    [_SOURCE_01, _SOURCE_02, _SOURCE_03, _SOURCE_04, _SOURCE_05, _SOURCE_06]
)
__compat_exec_globals__ = globals()
__compat_exec_globals__["__package__"] = "app.trading.autonomy"
exec(
    compile(__compat_source__, "app/trading/autonomy/lane.py", "exec"),
    __compat_exec_globals__,
)


def _default_strategy_configmap_path() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "argocd").is_dir() and (parent / "services" / "torghut").is_dir():
            return (
                parent
                / "argocd"
                / "applications"
                / "torghut"
                / "strategy-configmap.yaml"
            )
    return (
        Path(__file__).resolve().parents[6]
        / "argocd"
        / "applications"
        / "torghut"
        / "strategy-configmap.yaml"
    )


__all__ = [name for name in globals() if not name.startswith("__")]
