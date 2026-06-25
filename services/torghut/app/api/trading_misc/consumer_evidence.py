"""Consumer-evidence API routes."""

from __future__ import annotations

from fastapi import Query

from .consumer_evidence_payload import (
    build_trading_consumer_evidence_payload,
    consumer_evidence_summary_view,
)
from .router import router


@router.get("/trading/consumer-evidence")
def trading_consumer_evidence(
    view: str | None = Query(default=None),
) -> dict[str, object]:
    """Return Jangar-facing Torghut evidence without recursive Jangar status fetches."""

    return build_trading_consumer_evidence_payload(
        summary=consumer_evidence_summary_view(view)
    )


__all__ = ("trading_consumer_evidence",)
