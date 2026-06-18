"""Trading pipeline implementation."""

from __future__ import annotations


from .run_cycle import TradingPipelineRunCycleMixin
from .signal_processing import TradingPipelineSignalProcessingMixin
from .decision_lifecycle import TradingPipelineDecisionLifecycleMixin
from .submission_policy import TradingPipelineSubmissionPolicyMixin
from .runtime_gates import TradingPipelineRuntimeGatesMixin
from .llm_review import TradingPipelineReviewMixin
from .llm_outcomes import TradingPipelineReviewOutcomeMixin


class TradingPipeline(
    TradingPipelineRunCycleMixin,
    TradingPipelineSignalProcessingMixin,
    TradingPipelineDecisionLifecycleMixin,
    TradingPipelineSubmissionPolicyMixin,
    TradingPipelineRuntimeGatesMixin,
    TradingPipelineReviewMixin,
    TradingPipelineReviewOutcomeMixin,
    object,
):
    pass


__all__ = ["TradingPipeline"]
