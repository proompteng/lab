from __future__ import annotations

# ruff: noqa: F401

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import (
    Base,
    LLMDSPyWorkflowArtifact,
    LLMDecisionReview,
    Strategy,
    TradeDecision,
)
from app.trading.llm.dspy_compile import (
    build_compile_result,
    build_dspy_agentrun_payload,
    build_eval_report,
    orchestrate_dspy_agentrun_workflow,
    build_promotion_record,
    upsert_workflow_artifact_record,
    write_artifact_bundle,
)
from app.trading.llm.dspy_compile.workflow import _sanitize_idempotency_key


class _TestLLMDSPyWorkflowBase(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()


def _build_dspy_lane_overrides(
    artifact_root: Path,
    promote_overrides: dict[str, object] | None = None,
) -> dict[str, dict[str, object]]:
    root = str(artifact_root)
    overrides = {
        "dataset-build": {
            "datasetWindow": "P30D",
            "universeRef": "torghut:equity:enabled",
        },
        "compile": {
            "datasetRef": f"{root}/dataset-build/dspy-dataset.json",
            "metricPolicyRef": "config/trading/llm/dspy-metrics.yaml",
            "optimizer": "miprov2",
        },
        "eval": {
            "compileResultRef": f"{root}/compile/dspy-compile-result.json",
            "gatePolicyRef": "config/trading/llm/dspy-metrics.yaml",
        },
        "promote": {
            "evalReportRef": f"{root}/eval/dspy-eval-report.json",
            "promotionTarget": "constrained_live",
            "artifactHash": "a" * 64,
            "approvalRef": "risk-committee",
            "gateCompatibility": "pass",
            "schemaValidRate": "0.998",
            "deterministicCompatibility": "pass",
            "fallbackRate": "0.01",
        },
    }
    if promote_overrides:
        overrides["promote"].update(promote_overrides)
    return overrides


def _write_dspy_promotion_eval_snapshot(
    artifact_root: Path,
    *,
    gate_compatibility: str = "pass",
    schema_valid_rate: float = 0.999,
    deterministic_compatibility: bool = True,
    fallback_rate: float = 0.01,
    created_at: datetime | None = None,
) -> None:
    actual_created_at = created_at or datetime.now(timezone.utc)
    compile_result = build_compile_result(
        program_name="trade-review-committee-v1",
        signature_versions={"trade_review": "v1"},
        optimizer="miprov2",
        dataset_payload={"rows": [{"a": 1}, {"a": 2}]},
        metric_bundle={"schema_valid_rate": 0.999},
        compiled_prompt_payload={"prompt": "json-only advisory policy"},
        compiled_artifact_uri="s3://torghut-dspy/compile/result.json",
        seed="seed-42",
        created_at=actual_created_at,
    )
    eval_report = build_eval_report(
        compile_result=compile_result,
        schema_valid_rate=schema_valid_rate,
        veto_alignment_rate=0.9,
        false_veto_rate=0.01,
        latency_p95_ms=900,
        gate_compatibility=gate_compatibility,
        promotion_recommendation="paper",
        metric_bundle={
            "deterministicCompatibility": {"passed": deterministic_compatibility},
            "observed": {"fallbackRate": fallback_rate},
        },
        created_at=actual_created_at,
    )
    payload = eval_report.model_dump(mode="json", by_alias=True)
    output_path = artifact_root / "eval" / "dspy-eval-report.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
        encoding="utf-8",
    )


__all__ = [name for name in globals() if not name.startswith("__")]
