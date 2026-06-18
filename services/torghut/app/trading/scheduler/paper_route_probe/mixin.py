"""Paper-route probe mixin composition."""

from __future__ import annotations

from .probe_processing import SimplePipelinePaperRouteProbeProcessingMixin
from .retry_decisions import SimplePipelinePaperRouteProbeRetryDecisionMixin


class SimplePipelinePaperRouteProbeMixin(
    SimplePipelinePaperRouteProbeRetryDecisionMixin,
    SimplePipelinePaperRouteProbeProcessingMixin,
    object,
):
    pass


__all__ = ["SimplePipelinePaperRouteProbeMixin"]
