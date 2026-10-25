"""Resource lifecycle for a scheduler account pipeline."""

from __future__ import annotations

from typing import Protocol


class _Closable(Protocol):
    def close(self) -> None: ...


class TradingPipelineRuntimeResources(Protocol):
    @property
    def order_feed_ingestor(self) -> _Closable: ...

    @property
    def reconciler(self) -> _Closable: ...

    @property
    def capital_safety(self) -> _Closable: ...


def close_trading_pipeline_runtime_resources(
    pipeline: TradingPipelineRuntimeResources,
) -> None:
    pipeline.order_feed_ingestor.close()
    pipeline.reconciler.close()
    pipeline.capital_safety.close()


__all__ = ("close_trading_pipeline_runtime_resources",)
