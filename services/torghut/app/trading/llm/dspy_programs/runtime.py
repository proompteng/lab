"""Runtime adapter for executing DSPy review programs with artifact validation."""

from __future__ import annotations

import string
import time
from dataclasses import dataclass
from urllib.parse import urlsplit
from typing import Any, Literal, Mapping, cast

from ....config import settings
from ..dspy_compile.hashing import hash_payload
from ..schema import LLMReviewRequest, LLMReviewResponse
from .adapters import dspy_output_to_llm_response, review_request_to_dspy_input
from .modules import (
    DSPyCommitteeProgram,
    HeuristicCommitteeProgram,
    LiveDSPyCommitteeProgram,
)

_HASH_LENGTH = 64
_BOOTSTRAP_PROGRAM_NAME = "trade-review-committee-v1"
_BOOTSTRAP_SIGNATURE_VERSION = "v1"
_DSPY_OPENAI_BASE_PATH = "/openai/v1"
_DSPY_OPENAI_CHAT_COMPLETIONS_PATH = "/chat/completions"

_BOOTSTRAP_ARTIFACT_BODY = {
    "schema_version": "torghut.dspy.runtime-artifact.v1",
    "program_name": _BOOTSTRAP_PROGRAM_NAME,
    "signature_version": _BOOTSTRAP_SIGNATURE_VERSION,
    "executor": "heuristic",
    "compiled_prompt": {
        "promptTemplate": "torghut.dspy.trade-review.v1",
        "runtime": "deterministic_heuristic_scaffold",
    },
}
_BOOTSTRAP_ARTIFACT_HASH = hash_payload(_BOOTSTRAP_ARTIFACT_BODY)


class DSPyRuntimeError(RuntimeError):
    """Raised when DSPy runtime execution fails and caller may fallback."""


class DSPyRuntimeUnsupportedStateError(DSPyRuntimeError):
    """Raised when DSPy runtime is not in a state allowed for execution."""


@dataclass(frozen=True)
class DSPyArtifactManifest:
    """Runtime-validated artifact manifest used to execute review programs."""

    artifact_hash: str
    program_name: str
    signature_version: str
    executor: Literal["heuristic", "dspy_live"]
    compiled_prompt: dict[str, Any]
    source: str
    gate_compatibility: str | None = None


@dataclass(frozen=True)
class DSPyRuntimeMetadata:
    """Execution metadata attached to persisted advisory responses."""

    mode: str
    program_name: str
    signature_version: str
    artifact_hash: str
    artifact_source: str
    executor: str
    latency_ms: int
    advisory_only: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "program_name": self.program_name,
            "signature_version": self.signature_version,
            "artifact_hash": self.artifact_hash,
            "artifact_source": self.artifact_source,
            "executor": self.executor,
            "latency_ms": self.latency_ms,
            "advisory_only": self.advisory_only,
        }


class DSPyReviewRuntime:
    """Safe wrapper around artifact-gated DSPy review execution."""

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
        self.mode = mode
        self.artifact_hash = _normalize_hash(artifact_hash)
        self.program_name = program_name.strip() or _BOOTSTRAP_PROGRAM_NAME
        self.signature_version = (
            signature_version.strip() or _BOOTSTRAP_SIGNATURE_VERSION
        )
        self.timeout_seconds = max(timeout_seconds, 1)
        self._program_override = program
        self._program_cache: DSPyCommitteeProgram | None = None
        self._program_cache_key: tuple[str, str, str] | None = None
        self._manifest_cache: DSPyArtifactManifest | None = None
        self._manifest_cache_loaded_at_monotonic = 0.0
        self._manifest_cache_ttl_seconds = 60

    @classmethod
    def from_settings(cls) -> "DSPyReviewRuntime":
        return cls(
            mode=settings.llm_dspy_runtime_mode,
            artifact_hash=settings.llm_dspy_artifact_hash,
            program_name=settings.llm_dspy_program_name,
            signature_version=settings.llm_dspy_signature_version,
            timeout_seconds=settings.llm_dspy_timeout_seconds,
        )

    @classmethod
    def bootstrap_artifact_hash(cls) -> str:
        return _BOOTSTRAP_ARTIFACT_HASH

    def is_enabled(self) -> bool:
        return (
            self.mode in {"shadow", "active"}
            and bool(self.artifact_hash)
            and not (
                self.mode == "active"
                and self.artifact_hash == _BOOTSTRAP_ARTIFACT_HASH
            )
        )

    def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
        reasons: list[str] = []

        if self.mode != "active":
            reasons.append("dspy_live_runtime_mode_not_active")
        elif settings.trading_mode == "live":
            gate_allowed, gate_reasons = settings.llm_dspy_live_runtime_gate()
            if not gate_allowed:
                reasons.extend(gate_reasons)
        if self.artifact_hash is None:
            reasons.append("dspy_artifact_hash_missing")
        elif self.artifact_hash == _BOOTSTRAP_ARTIFACT_HASH:
            reasons.append("dspy_bootstrap_artifact_forbidden")
        try:
            _resolve_dspy_model_name()
            _resolve_dspy_completion_url()
        except DSPyRuntimeUnsupportedStateError as exc:
            reasons.append(str(exc))
        if reasons:
            return False, tuple(reasons)

        try:
            manifest = self._resolve_artifact_manifest()
            self._validate_manifest(manifest)
        except DSPyRuntimeUnsupportedStateError as exc:
            return False, (str(exc),)
        except Exception as exc:
            return False, (f"dspy_live_readiness_error:{type(exc).__name__}",)

        if manifest.executor != "dspy_live":
            return False, ("dspy_active_mode_requires_dspy_live_executor",)

        return True, ()

    def review(
        self, request: LLMReviewRequest
    ) -> tuple[LLMReviewResponse, DSPyRuntimeMetadata]:
        if self.mode == "disabled":
            raise DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
        if self.artifact_hash is None:
            raise DSPyRuntimeUnsupportedStateError("dspy_artifact_hash_missing")
        if (
            self.mode == "active"
            and self.artifact_hash == _BOOTSTRAP_ARTIFACT_HASH
        ):
            raise DSPyRuntimeUnsupportedStateError("dspy_bootstrap_artifact_forbidden")

        if self.mode == "active":
            live_ready, live_reasons = self.evaluate_live_readiness()
            if not live_ready:
                reason = live_reasons[0] if live_reasons else "dspy_live_runtime_not_ready"
                raise DSPyRuntimeUnsupportedStateError(reason)

        manifest = self._resolve_artifact_manifest()
        self._validate_manifest(manifest)
        if manifest.executor not in {"heuristic", "dspy_live"}:
            raise DSPyRuntimeUnsupportedStateError("dspy_artifact_executor_unknown")
        if self.mode == "active" and manifest.executor != "dspy_live":
            raise DSPyRuntimeUnsupportedStateError(
                "dspy_active_mode_requires_dspy_live_executor"
            )
        program = self._resolve_program(manifest)

        payload = review_request_to_dspy_input(
            request,
            artifact_hash=self.artifact_hash,
            program_name=self.program_name,
            signature_version=self.signature_version,
        )

        started_at = time.monotonic()
        try:
            output = program.run(payload)
        except Exception as exc:
            raise DSPyRuntimeError(
                f"dspy_program_failed:{type(exc).__name__}:{exc}"
            ) from exc

        elapsed = time.monotonic() - started_at
        if elapsed > self.timeout_seconds:
            raise DSPyRuntimeError(
                f"dspy_program_timeout:elapsed={elapsed:.3f}s limit={self.timeout_seconds}s"
            )

        try:
            response = dspy_output_to_llm_response(output)
        except Exception as exc:
            raise DSPyRuntimeError(
                f"dspy_output_invalid:{type(exc).__name__}:{exc}"
            ) from exc
        metadata = DSPyRuntimeMetadata(
            mode=self.mode,
            program_name=self.program_name,
            signature_version=self.signature_version,
            artifact_hash=self.artifact_hash,
            artifact_source=manifest.source,
            executor=manifest.executor,
            latency_ms=int(elapsed * 1000),
        )
        return response, metadata

    def _resolve_artifact_manifest(self) -> DSPyArtifactManifest:
        if self.artifact_hash is None:
            raise DSPyRuntimeUnsupportedStateError("dspy_artifact_hash_missing")

        now = time.monotonic()
        if (
            self._manifest_cache is not None
            and self._manifest_cache.artifact_hash == self.artifact_hash
            and (now - self._manifest_cache_loaded_at_monotonic)
            <= self._manifest_cache_ttl_seconds
        ):
            return self._manifest_cache

        if self.artifact_hash == _BOOTSTRAP_ARTIFACT_HASH:
            manifest = DSPyArtifactManifest(
                artifact_hash=_BOOTSTRAP_ARTIFACT_HASH,
                program_name=_BOOTSTRAP_PROGRAM_NAME,
                signature_version=_BOOTSTRAP_SIGNATURE_VERSION,
                executor="heuristic",
                compiled_prompt=cast(
                    dict[str, Any], _BOOTSTRAP_ARTIFACT_BODY["compiled_prompt"]
                ),
                source="bootstrap",
                gate_compatibility="pass",
            )
        else:
            manifest = self._load_manifest_from_db(self.artifact_hash)

        if manifest is None:
            raise DSPyRuntimeUnsupportedStateError("dspy_artifact_manifest_not_found")

        self._manifest_cache = manifest
        self._manifest_cache_loaded_at_monotonic = now
        return manifest

    def _load_manifest_from_db(self, artifact_hash: str) -> DSPyArtifactManifest | None:
        try:
            from sqlalchemy import select

            from ....db import SessionLocal
            from ....models import LLMDSPyWorkflowArtifact
        except Exception as exc:
            raise DSPyRuntimeError(
                f"dspy_manifest_db_dependency_error:{type(exc).__name__}:{exc}"
            ) from exc

        with SessionLocal() as session:
            row = (
                session.execute(
                    select(LLMDSPyWorkflowArtifact)
                    .where(LLMDSPyWorkflowArtifact.artifact_hash == artifact_hash)
                    .order_by(LLMDSPyWorkflowArtifact.created_at.desc())
                )
                .scalars()
                .first()
            )

        if row is None:
            return None

        if row.gate_compatibility and row.gate_compatibility != "pass":
            raise DSPyRuntimeUnsupportedStateError(
                "dspy_artifact_gate_compatibility_failed"
            )

        signature_versions = _parse_signature_versions(row.signature_version)
        if not signature_versions:
            signature_versions = {"trade_review": self.signature_version}

        program_name = (row.program_name or "").strip()
        if not program_name:
            raise DSPyRuntimeUnsupportedStateError("dspy_artifact_program_name_missing")

        if not row.optimizer or not row.dataset_hash or not row.compiled_prompt_hash:
            raise DSPyRuntimeUnsupportedStateError(
                "dspy_artifact_missing_compile_fields"
            )
        if not row.artifact_uri or not row.reproducibility_hash:
            raise DSPyRuntimeUnsupportedStateError(
                "dspy_artifact_missing_reproducibility_fields"
            )

        computed_hash = hash_payload(
            {
                "program_name": program_name,
                "signature_versions": signature_versions,
                "optimizer": row.optimizer,
                "dataset_hash": row.dataset_hash,
                "compiled_prompt_hash": row.compiled_prompt_hash,
                "compiled_artifact_uri": row.artifact_uri,
                "reproducibility_hash": row.reproducibility_hash,
            }
        )
        if computed_hash != artifact_hash:
            raise DSPyRuntimeUnsupportedStateError("dspy_artifact_hash_mismatch")

        metadata: dict[str, Any] = {}
        metadata_raw = row.metadata_json
        if isinstance(metadata_raw, dict):
            metadata_items = cast(dict[Any, Any], metadata_raw)
            metadata = {str(key): value for key, value in metadata_items.items()}

        executor_raw = str(metadata.get("executor") or "heuristic").strip().lower()
        if executor_raw in {"dspy", "dspy_live", "live"}:
            executor: Literal["heuristic", "dspy_live"] = "dspy_live"
        elif executor_raw == "heuristic":
            executor = "heuristic"
        else:
            raise DSPyRuntimeUnsupportedStateError("dspy_artifact_executor_unknown")

        compiled_prompt_raw = metadata.get("compiled_prompt")
        compiled_prompt: dict[str, Any] = {}
        if isinstance(compiled_prompt_raw, dict):
            compiled_prompt = cast(dict[str, Any], compiled_prompt_raw)

        return DSPyArtifactManifest(
            artifact_hash=artifact_hash,
            program_name=program_name,
            signature_version=_pick_signature_version(
                signature_versions, self.signature_version
            ),
            executor=executor,
            compiled_prompt=compiled_prompt,
            source="database",
            gate_compatibility=row.gate_compatibility,
        )

    def _resolve_program(self, manifest: DSPyArtifactManifest) -> DSPyCommitteeProgram:
        if self._program_override is not None:
            return self._program_override

        cache_key = (
            manifest.artifact_hash,
            manifest.executor,
            manifest.signature_version,
        )
        if self._program_cache is not None and self._program_cache_key == cache_key:
            return self._program_cache

        if manifest.executor == "dspy_live":
            program = LiveDSPyCommitteeProgram(
                model_name=_resolve_dspy_model_name(),
                api_base=_resolve_dspy_api_base(),
                api_key=settings.jangar_api_key.strip()
                if settings.jangar_api_key
                else None,
            )
        else:
            program = HeuristicCommitteeProgram()

        self._program_cache = program
        self._program_cache_key = cache_key
        return program

    def _validate_manifest(self, manifest: DSPyArtifactManifest) -> None:
        if manifest.program_name != self.program_name:
            raise DSPyRuntimeUnsupportedStateError("dspy_program_name_mismatch")
        if manifest.signature_version != self.signature_version:
            raise DSPyRuntimeUnsupportedStateError("dspy_signature_version_mismatch")


def _normalize_hash(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if not normalized:
        return None
    if len(normalized) != _HASH_LENGTH:
        raise DSPyRuntimeUnsupportedStateError("dspy_artifact_hash_invalid_length")
    if any(ch not in string.hexdigits for ch in normalized):
        raise DSPyRuntimeUnsupportedStateError("dspy_artifact_hash_not_hex")
    return normalized


def _parse_signature_versions(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    parsed: dict[str, str] = {}
    for chunk in raw.split(","):
        item = chunk.strip()
        if not item:
            continue
        key, sep, value = item.partition(":")
        if sep and key.strip() and value.strip():
            parsed[key.strip()] = value.strip()
        elif item:
            parsed["trade_review"] = item
    return parsed


def _pick_signature_version(
    signature_versions: Mapping[str, str], preferred: str
) -> str:
    preferred_normalized = preferred.strip()
    if preferred_normalized and preferred_normalized in signature_versions.values():
        return preferred_normalized
    if signature_versions:
        first = next(iter(signature_versions.values())).strip()
        if first:
            return first
    return preferred_normalized or _BOOTSTRAP_SIGNATURE_VERSION


def _resolve_dspy_model_name() -> str:
    raw = settings.llm_model.strip()
    if not raw:
        raise DSPyRuntimeUnsupportedStateError("dspy_model_not_configured")
    if "/" in raw:
        return raw
    return f"openai/{raw}"


def _resolve_dspy_api_base() -> str:
    raw_base_url = (settings.jangar_base_url or "").strip()
    if not raw_base_url:
        raise DSPyRuntimeUnsupportedStateError("dspy_jangar_base_url_missing")

    parsed = urlsplit(raw_base_url)
    if not parsed.hostname:
        raise DSPyRuntimeUnsupportedStateError("dspy_jangar_base_url_missing")
    if parsed.scheme not in {"http", "https"}:
        raise DSPyRuntimeUnsupportedStateError(
            "dspy_jangar_base_url_invalid_scheme"
        )
    if parsed.query or parsed.fragment:
        raise DSPyRuntimeUnsupportedStateError(
            "dspy_jangar_base_url_invalid_path"
        )

    base_path = (parsed.path or "/").rstrip("/")
    for suffix in (_DSPY_OPENAI_CHAT_COMPLETIONS_PATH,):
        if base_path.endswith(suffix):
            base_path = base_path[: -len(suffix)]
            break

    if base_path == "":
        base_path = ""

    if not base_path.endswith(_DSPY_OPENAI_BASE_PATH):
        base_path = f"{base_path}{_DSPY_OPENAI_BASE_PATH}"

    normalized_base = f"{parsed.scheme}://{parsed.netloc}{base_path}"
    return normalized_base


def _resolve_dspy_completion_url() -> str:
    return f"{_resolve_dspy_api_base()}{_DSPY_OPENAI_CHAT_COMPLETIONS_PATH}"


__all__ = [
    "DSPyRuntimeError",
    "DSPyRuntimeUnsupportedStateError",
    "DSPyRuntimeMetadata",
    "DSPyReviewRuntime",
]
