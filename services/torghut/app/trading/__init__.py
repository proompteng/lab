"""Trading pipeline modules for torghut."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .scheduler import TradingScheduler


def __getattr__(name: str):
    if name == "TradingScheduler":
        from .scheduler import TradingScheduler

        return TradingScheduler
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["TradingScheduler"]
