"""DSPy program scaffolding and runtime adapters for Torghut."""

from .adapters import dspy_output_to_llm_response, review_request_to_dspy_input
from .modules import DSPyCommitteeProgram, HeuristicCommitteeProgram
from .runtime import DSPyReviewRuntime, DSPyRuntimeError, DSPyRuntimeMetadata
from .signatures import (
    DSPyCommitteeMemberOutput,
    DSPyCommitteeRole,
    DSPyTradeReviewInput,
    DSPyTradeReviewOutput,
    DSPyVerdict,
)

__all__ = [
    "DSPyCommitteeProgram",
    "DSPyCommitteeMemberOutput",
    "DSPyCommitteeRole",
    "DSPyReviewRuntime",
    "DSPyRuntimeError",
    "DSPyRuntimeMetadata",
    "DSPyTradeReviewInput",
    "DSPyTradeReviewOutput",
    "DSPyVerdict",
    "HeuristicCommitteeProgram",
    "dspy_output_to_llm_response",
    "review_request_to_dspy_input",
]
