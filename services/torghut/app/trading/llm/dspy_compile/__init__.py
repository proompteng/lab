"""DSPy compile/eval/promotion scaffolding for Torghut."""

from .dataset import (
    DATASET_METADATA_SCHEMA_VERSION,
    DATASET_SCHEMA_VERSION,
    DEFAULT_SAMPLING_SEED,
    DSPyDatasetBuildResult,
    build_dspy_dataset_artifacts,
)
from .hashing import canonical_json, hash_payload, sha256_hex
from .schemas import (
    DSPyArtifactBundle,
    DSPyCompileResult,
    DSPyEvalReport,
    DSPyPromotionRecord,
)
from .workflow import (
    DSPyWorkflowLane,
    build_compile_result,
    build_dspy_agentrun_payload,
    build_eval_report,
    orchestrate_dspy_agentrun_workflow,
    build_promotion_record,
    bundle_artifacts,
    submit_jangar_agentrun,
    upsert_workflow_artifact_record,
    write_artifact_bundle,
)

__all__ = [
    "DSPyArtifactBundle",
    "DSPyCompileResult",
    "DSPyDatasetBuildResult",
    "DSPyEvalReport",
    "DSPyPromotionRecord",
    "DSPyWorkflowLane",
    "DATASET_METADATA_SCHEMA_VERSION",
    "DATASET_SCHEMA_VERSION",
    "DEFAULT_SAMPLING_SEED",
    "build_compile_result",
    "build_dspy_dataset_artifacts",
    "build_dspy_agentrun_payload",
    "build_eval_report",
    "orchestrate_dspy_agentrun_workflow",
    "build_promotion_record",
    "bundle_artifacts",
    "canonical_json",
    "hash_payload",
    "sha256_hex",
    "submit_jangar_agentrun",
    "upsert_workflow_artifact_record",
    "write_artifact_bundle",
]
