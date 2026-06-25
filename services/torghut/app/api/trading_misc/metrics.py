"""Trading metrics API route."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.orm import Session

from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST, BUILD_VERSION
from app.db import get_session

from ..health_checks import (
    build_control_plane_contract as _build_control_plane_contract,
)
from ..health_checks import (
    build_hypothesis_runtime_payload as _build_hypothesis_runtime_payload,
)
from ..health_checks import (
    build_shadow_first_runtime_payload as _build_shadow_first_runtime_payload,
)
from ..health_checks import load_tca_summary as _load_tca_summary
from ..trading_scheduler_state import get_trading_scheduler
from .router import router


@router.get("/trading/metrics")
def trading_metrics(session: Session = Depends(get_session)) -> dict[str, object]:
    """Expose trading metrics counters."""

    scheduler = get_trading_scheduler()
    metrics = scheduler.state.metrics
    market_context_status = scheduler.market_context_status()
    tca_summary = _load_tca_summary(session, scheduler=scheduler)
    _hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=scheduler.state,
        hypothesis_summary=hypothesis_summary,
    )
    return {
        "metrics": metrics.to_payload(),
        "build": {
            "version": BUILD_VERSION,
            "commit": BUILD_COMMIT,
            "image_digest": BUILD_IMAGE_DIGEST,
            "active_revision": shadow_first_runtime["active_revision"],
        },
        "shadow_first": shadow_first_runtime,
        "tca": tca_summary,
        "control_plane_contract": _build_control_plane_contract(
            scheduler.state,
            hypothesis_summary=hypothesis_summary,
            dependency_quorum=hypothesis_dependency_quorum,
        ),
    }


__all__ = ("trading_metrics",)
