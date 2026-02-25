"""Runtime adapter for executing DSPy-scaffold review programs safely."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from ....config import settings
from ..schema import LLMReviewRequest, LLMReviewResponse
from .adapters import dspy_output_to_llm_response, review_request_to_dspy_input
from .modules import DSPyCommitteeProgram, HeuristicCommitteeProgram


class DSPyRuntimeError(RuntimeError):
    """Raised when DSPy runtime execution fails and caller should fallback."""


@dataclass(frozen=True)
class DSPyRuntimeMetadata:
    """Execution metadata attached to persisted advisory responses."""

    mode: str
    program_name: str
    signature_version: str
    artifact_hash: str
    latency_ms: int
    advisory_only: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "program_name": self.program_name,
            "signature_version": self.signature_version,
            "artifact_hash": self.artifact_hash,
            "latency_ms": self.latency_ms,
            "advisory_only": self.advisory_only,
        }


class DSPyReviewRuntime:
    """Safe wrapper around deterministic DSPy-scaffold program execution."""

    def __init__(
        self,
        *,
        mode: str,
        artifact_hash: str | None,
        program_name: str,
        signature_version: str,
        timeout_seconds: int,
        program: DSPyCommitteeProgram | None = None,
    ) -> None:
        self.mode = mode.strip().lower()
        self.artifact_hash = (artifact_hash or "").strip() or None
        self.program_name = program_name.strip() or "trade-review-committee-v1"
        self.signature_version = signature_version.strip() or "v1"
        self.timeout_seconds = max(timeout_seconds, 1)
        self._program = program or HeuristicCommitteeProgram()

    @classmethod
    def from_settings(cls) -> "DSPyReviewRuntime":
        return cls(
            mode=settings.llm_dspy_runtime_mode,
            artifact_hash=settings.llm_dspy_artifact_hash,
            program_name=settings.llm_dspy_program_name,
            signature_version=settings.llm_dspy_signature_version,
            timeout_seconds=settings.llm_dspy_timeout_seconds,
        )

    def is_enabled(self) -> bool:
        return self.mode in {"shadow", "active"} and bool(self.artifact_hash)

    def review(self, request: LLMReviewRequest) -> tuple[LLMReviewResponse, DSPyRuntimeMetadata]:
        if not self.is_enabled():
            raise DSPyRuntimeError("dspy_runtime_disabled")
        if self.artifact_hash is None:
            raise DSPyRuntimeError("dspy_artifact_hash_missing")

        payload = review_request_to_dspy_input(
            request,
            artifact_hash=self.artifact_hash,
            program_name=self.program_name,
            signature_version=self.signature_version,
        )
        started_at = time.monotonic()
        try:
            output = self._program.run(payload)
        except Exception as exc:
            raise DSPyRuntimeError(f"dspy_program_failed:{type(exc).__name__}:{exc}") from exc

        elapsed = time.monotonic() - started_at
        if elapsed > self.timeout_seconds:
            raise DSPyRuntimeError(
                f"dspy_program_timeout:elapsed={elapsed:.3f}s limit={self.timeout_seconds}s"
            )

        response = dspy_output_to_llm_response(output)
        metadata = DSPyRuntimeMetadata(
            mode=self.mode,
            program_name=self.program_name,
            signature_version=self.signature_version,
            artifact_hash=self.artifact_hash,
            latency_ms=int(elapsed * 1000),
        )
        return response, metadata


__all__ = ["DSPyRuntimeError", "DSPyRuntimeMetadata", "DSPyReviewRuntime"]
