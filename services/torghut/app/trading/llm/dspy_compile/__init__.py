"""DSPy compile/eval/promotion scaffolding for Torghut."""

from .dataset import (
    DATASET_METADATA_SCHEMA_VERSION,
    DATASET_SCHEMA_VERSION,
    DEFAULT_SAMPLING_SEED,
    DSPyDatasetBuildResult,
    build_dspy_dataset_artifacts,
)
from .compiler import (
    COMPILED_ARTIFACT_SCHEMA_VERSION,
    COMPILE_METRICS_SCHEMA_VERSION,
    DEFAULT_COMPILE_METRICS_NAME,
    DEFAULT_COMPILE_RESULT_NAME,
    DEFAULT_COMPILE_SEED,
    DEFAULT_COMPILED_ARTIFACT_NAME,
    DEFAULT_PROGRAM_NAME,
    DEFAULT_SIGNATURE_VERSION,
    DSPyCompileArtifactResult,
    compile_dspy_program_artifacts,
)
from .evaluator import (
    DEFAULT_EVAL_REPORT_NAME,
    DSPyEvalArtifactResult,
    evaluate_dspy_compile_artifact,
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
    "COMPILED_ARTIFACT_SCHEMA_VERSION",
    "COMPILE_METRICS_SCHEMA_VERSION",
    "DEFAULT_COMPILE_METRICS_NAME",
    "DEFAULT_COMPILE_RESULT_NAME",
    "DEFAULT_COMPILE_SEED",
    "DEFAULT_COMPILED_ARTIFACT_NAME",
    "DEFAULT_EVAL_REPORT_NAME",
    "DEFAULT_PROGRAM_NAME",
    "DEFAULT_SIGNATURE_VERSION",
    "DEFAULT_SAMPLING_SEED",
    "DSPyCompileArtifactResult",
    "DSPyEvalArtifactResult",
    "build_compile_result",
    "compile_dspy_program_artifacts",
    "evaluate_dspy_compile_artifact",
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
