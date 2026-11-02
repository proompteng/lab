"""Run rejected-signal outcome learning outside the order-execution path."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence

from .pipeline import TradingPipeline

logger = logging.getLogger(__name__)


async def run_rejected_signal_outcome_iteration(
    pipelines: Sequence[TradingPipeline],
) -> None:
    calls: list[tuple[str, Callable[[], object]]] = []
    for pipeline in pipelines:
        label_outcomes = getattr(
            pipeline,
            "label_mature_rejected_signal_outcomes",
            None,
        )
        if callable(label_outcomes):
            calls.append((pipeline.account_label, label_outcomes))
    if not calls:
        return

    outcomes = await asyncio.gather(
        *(asyncio.to_thread(label_outcomes) for _, label_outcomes in calls),
        return_exceptions=True,
    )
    for (account_label, _), outcome in zip(calls, outcomes, strict=True):
        if isinstance(outcome, Exception):
            logger.error(
                "Rejected signal outcome lane failed account=%s error=%s",
                account_label,
                outcome,
                exc_info=(type(outcome), outcome, outcome.__traceback__),
            )
        elif isinstance(outcome, BaseException):
            raise outcome


__all__ = ["run_rejected_signal_outcome_iteration"]
