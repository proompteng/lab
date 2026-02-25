"""Schema contracts for DSPy compile/eval/promotion artifacts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DSPyCompileResult(BaseModel):
    """Canonical compile artifact contract."""

    model_config = ConfigDict(extra="forbid")

    program_name: str = Field(alias="programName")
    signature_versions: dict[str, str] = Field(alias="signatureVersions")
    optimizer: str
    dataset_hash: str = Field(alias="datasetHash")
    metric_bundle: dict[str, Any] = Field(alias="metricBundle")
    compiled_prompt_hash: str = Field(alias="compiledPromptHash")
    compiled_artifact_uri: str = Field(alias="compiledArtifactUri")
    artifact_hash: str = Field(alias="artifactHash")
    reproducibility_hash: str = Field(alias="reproducibilityHash")
    created_at: datetime = Field(default_factory=_utcnow, alias="createdAt")

    @field_validator(
        "dataset_hash",
        "compiled_prompt_hash",
        "artifact_hash",
        "reproducibility_hash",
    )
    @classmethod
    def validate_hashes(cls, value: str) -> str:
        normalized = value.strip().lower()
        if len(normalized) != 64:
            raise ValueError("hash_must_be_sha256_hex")
        return normalized


class DSPyEvalReport(BaseModel):
    """Canonical evaluation artifact contract."""

    model_config = ConfigDict(extra="forbid")

    artifact_hash: str = Field(alias="artifactHash")
    schema_valid_rate: float = Field(ge=0.0, le=1.0, alias="schemaValidRate")
    veto_alignment_rate: float = Field(ge=0.0, le=1.0, alias="vetoAlignmentRate")
    false_veto_rate: float = Field(ge=0.0, le=1.0, alias="falseVetoRate")
    latency_p95_ms: int = Field(ge=0, alias="latencyP95Ms")
    gate_compatibility: Literal["pass", "fail"] = Field(alias="gateCompatibility")
    promotion_recommendation: Literal["hold", "paper", "shadow", "constrained_live", "scaled_live"] = Field(
        alias="promotionRecommendation"
    )
    metric_bundle: dict[str, Any] = Field(default_factory=dict, alias="metricBundle")
    eval_hash: str = Field(alias="evalHash")
    created_at: datetime = Field(default_factory=_utcnow, alias="createdAt")

    @field_validator("artifact_hash", "eval_hash")
    @classmethod
    def validate_hashes(cls, value: str) -> str:
        normalized = value.strip().lower()
        if len(normalized) != 64:
            raise ValueError("hash_must_be_sha256_hex")
        return normalized


class DSPyPromotionRecord(BaseModel):
    """Canonical promotion artifact contract."""

    model_config = ConfigDict(extra="forbid")

    artifact_hash: str = Field(alias="artifactHash")
    eval_hash: str = Field(alias="evalHash")
    promotion_target: Literal["paper", "shadow", "constrained_live", "scaled_live"] = Field(alias="promotionTarget")
    approved: bool
    approval_token_ref: str | None = Field(default=None, alias="approvalTokenRef")
    promoted_by: str | None = Field(default=None, alias="promotedBy")
    promotion_hash: str = Field(alias="promotionHash")
    created_at: datetime = Field(default_factory=_utcnow, alias="createdAt")

    @field_validator("artifact_hash", "eval_hash", "promotion_hash")
    @classmethod
    def validate_hashes(cls, value: str) -> str:
        normalized = value.strip().lower()
        if len(normalized) != 64:
            raise ValueError("hash_must_be_sha256_hex")
        return normalized


class DSPyArtifactBundle(BaseModel):
    """Bundle that groups compile/eval/promotion artifacts plus manifest hashes."""

    model_config = ConfigDict(extra="forbid")

    compile_result: DSPyCompileResult = Field(alias="compileResult")
    eval_report: DSPyEvalReport = Field(alias="evalReport")
    promotion_record: DSPyPromotionRecord | None = Field(default=None, alias="promotionRecord")
    manifest_hash: str = Field(alias="manifestHash")
    artifact_hashes: dict[str, str] = Field(alias="artifactHashes")


__all__ = [
    "DSPyArtifactBundle",
    "DSPyCompileResult",
    "DSPyEvalReport",
    "DSPyPromotionRecord",
]
