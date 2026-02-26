# Priority 12: DSPy Adoption for Torghut Quant + LLM Autonomous Trading

## Status

- Version: `v1`
- Date: `2026-02-25`
- Maturity: `implementation plan + partial scaffolding landed`
- Scope: adopt DSPy for LLM-program authoring/optimization while preserving deterministic trading safety and Jangar-native AgentRun control-plane operations

## Audit Update (2026-02-26)

- DSPy program/runtime scaffolding and compile/eval/promotion artifact contracts are implemented in Torghut code.
- Jangar-compatible AgentRun payload builder/tests and DSPy artifact persistence migration are present.
- Full production adoption criteria in this document remain partially open (rollout and promotion-governed runtime usage).

## Objective

Adopt DSPy as Torghut's LLM program layer for research and advisory components so we can:

1. replace brittle, hand-written prompt strings with typed program signatures,
2. optimize LLM programs offline using reproducible metrics,
3. version and promote compiled LLM artifacts with the same governance model used for trading promotion,
4. execute all compile/eval/promote automation through Jangar control-plane AgentRuns.

## Why DSPy for Torghut

DSPy is a Python framework for programming language models with typed signatures, composable modules, and optimizers
that compile programs against task metrics. This aligns with Torghut's existing requirements for deterministic evidence,
auditability, and staged promotion.

Key DSPy capabilities relevant to Torghut:

- signatures define task I/O contracts independent of prompt wording,
- modules (`dspy.Predict`, `dspy.ChainOfThought`, `dspy.ReAct`, compositions) represent reusable LLM program steps,
- optimizers (for example `MIPROv2`, `BootstrapRS`, `GEPA`) tune prompts/examples from data and a metric.

## Non-Negotiable Invariants

- DSPy outputs remain advisory for trading execution; deterministic risk gates remain final authority.
- No DSPy path may bypass gate/policy checks in `services/torghut/app/trading/autonomy/**`.
- Live promotion remains fail-closed and evidence-backed.
- All DSPy compile/eval/promote workflows must run through Jangar control plane (`POST /v1/agent-runs`), not ad-hoc runtime jobs.

## Scope

### In Scope

- DSPy-based LLM program layer for:
  - trade decision review/committee advisory,
  - whitepaper synthesis + implementation viability grading helpers,
  - research-to-engineering candidate scoring support.
- Offline DSPy compile/eval pipelines with reproducibility artifacts.
- Artifact/version governance and rollout integration with Torghut autonomy gates.
- Jangar-compatible AgentRun/ImplementationSpec catalog for DSPy workflows.

### Out of Scope

- Replacing deterministic risk engine with DSPy logic.
- Direct DSPy-driven order execution.
- Unbounded online self-modification of live prompts without gate evidence.

## Current Torghut Anchors

- LLM advisory runtime: `services/torghut/app/trading/llm/review_engine.py`
- Deterministic policy and gate chain: `services/torghut/app/trading/autonomy/**`
- Whitepaper ingestion/finalize + AgentRun dispatch: `services/torghut/app/whitepapers/workflow.py`
- Jangar AgentRun endpoint/control plane: `services/jangar/src/routes/v1/agent-runs.ts`, `docs/jangar/primitives/control-plane.md`

## Target Architecture

### A. DSPy Program Layer (Authoring)

Create `services/torghut/app/trading/llm/dspy_programs/` with:

- typed signatures for review, critique, and grading tasks,
- composable modules that mirror Torghut committee roles,
- adapters converting between DSPy outputs and existing Pydantic schemas in `services/torghut/app/trading/llm/schema.py`.

### B. DSPy Compile Layer (Offline)

Create `services/torghut/app/trading/llm/dspy_compile/`:

- dataset builders from historical decisions, gate outcomes, and whitepaper verdict history,
- metric functions tied to Torghut outcomes (schema validity, veto alignment, false-positive veto rate, latency budget fit),
- optimizer runners (`MIPROv2` baseline; optional GEPA lane for advanced optimization).

### C. DSPy Serving Layer (Runtime)

- runtime loads pinned compiled artifact versions (hash + version id),
- committee/review path uses DSPy module output as advisory payload,
- deterministic fallback to current non-DSPy review path on timeout/error/schema mismatch.

### D. Governance Layer

- compile outputs stored as immutable artifacts (`artifact_uri`, `artifact_hash`, `dataset_hash`, `metric_bundle`),
- promotion to paper/shadow/live references DSPy artifact version in gate evidence.

## Jangar Control-Plane Compatibility (Required)

All DSPy automation must be represented as Jangar AgentRuns (or Orchestration steps that create AgentRuns) with these rules:

1. create runs through `POST /v1/agent-runs`,
2. provide idempotency via request `Idempotency-Key` and payload `idempotencyKey`,
3. prefer `implementationSpecRef` (avoid large inline logic for production lanes),
4. include `vcsRef` + `vcsPolicy` for code-changing lanes,
5. include top-level `ttlSecondsAfterFinished`,
6. include `policy.secretBindingRef` when secrets are required,
7. keep `parameters` string-typed and explicitly versioned.

Required payload shape (conceptual):

```json
{
  "namespace": "agents",
  "idempotencyKey": "torghut-dspy-compile-<dataset-hash>",
  "agentRef": { "name": "codex-agent" },
  "implementationSpecRef": { "name": "torghut-dspy-compile-mipro-v1" },
  "runtime": { "type": "workflow" },
  "vcsRef": { "name": "github" },
  "vcsPolicy": { "required": true, "mode": "read-write" },
  "parameters": {
    "repository": "proompteng/lab",
    "base": "main",
    "head": "codex/torghut-dspy-compile-<date>",
    "datasetRef": "s3://.../dataset.json",
    "metricPolicyRef": "config/trading/llm/dspy-metrics.yaml",
    "artifactPath": "artifacts/dspy/<run-id>"
  },
  "policy": {
    "secretBindingRef": "codex-whitepaper-github-token"
  },
  "ttlSecondsAfterFinished": 14400
}
```

## Data Contracts

### DSPy Compile Artifact (`dspy-compile-result.json`)

- `program_name`
- `signature_versions`
- `optimizer` (`miprov2|bootstraprs|gepa|...`)
- `dataset_hash`
- `metric_bundle`
- `compiled_prompt_hash`
- `compiled_artifact_uri`
- `created_at`

### DSPy Evaluation Artifact (`dspy-eval-report.json`)

- `artifact_hash`
- `schema_valid_rate`
- `veto_alignment_rate`
- `false_veto_rate`
- `latency_p95_ms`
- `gate_compatibility` (`pass|fail`)
- `promotion_recommendation` (`hold|paper|shadow|constrained_live|scaled_live`)

## Integration Plan

### Phase 0: Baseline + Harness

- add DSPy dependency and isolated compile/eval harnesses in Torghut service.
- keep runtime behavior unchanged.

### Phase 1: Committee Advisory Pilot

- wire DSPy module path behind feature flag (for example `TORGHUT_LLM_DSPY_ENABLED`).
- run shadow advisory comparisons against existing `LLMReviewEngine`.

### Phase 2: Whitepaper + Research Scoring

- use DSPy signatures/modules for structured whitepaper synthesis quality checks and implementation-grade scoring support.
- preserve existing whitepaper workflow contracts and DB schemas.

### Phase 3: Promotion-Governed Runtime Adoption

- allow DSPy advisory artifact versions in paper and shadow only after compile/eval criteria pass.
- controlled live enablement only through existing deterministic gate chain and rollout policies.

## ImplementationSpec Catalog (DSPy)

### `torghut-dspy-dataset-build-v1`

- Purpose: build/normalize compile dataset from Torghut historical records.
- Required keys: `datasetWindow`, `sourceRefs`, `artifactPath`.

### `torghut-dspy-compile-mipro-v1`

- Purpose: compile target DSPy program using `MIPROv2`.
- Required keys: `datasetRef`, `metricPolicyRef`, `artifactPath`.

### `torghut-dspy-eval-v1`

- Purpose: evaluate compiled artifact against holdout set and gate-compatibility checks.
- Required keys: `compiledArtifactRef`, `evalDatasetRef`, `artifactPath`.

### `torghut-dspy-gepa-experiment-v1`

- Purpose: optional advanced compile lane using GEPA for reflective optimization.
- Required keys: `datasetRef`, `metricPolicyRef`, `artifactPath`, `experimentTag`.

### `torghut-dspy-promote-artifact-v1`

- Purpose: register approved DSPy artifact version for paper/shadow/live candidate use.
- Required keys: `compiledArtifactRef`, `evalReportRef`, `promotionTarget`, `approvalToken`, `artifactPath`.

## Metrics and SLOs

- DSPy output schema validity >= 99.5%.
- Advisory veto alignment improvement over baseline >= configured delta.
- Compile reproducibility: identical dataset + optimizer + seed => identical artifact hash.
- Runtime fallback reliability: DSPy failure must not block deterministic-only trading path.

## Risks and Mitigations

- Optimizer overfit to backtests:
  - mitigate with strict holdout regimes and leakage checks.
- Latency increase in runtime:
  - mitigate via bounded token budget, caching, and deterministic fallback.
- Control-plane drift from ad-hoc scripts:
  - mitigate by enforcing Jangar-only AgentRun creation path and policy checks.
- Artifact sprawl/version confusion:
  - mitigate with immutable hash-indexed registry and promotion lineage records.

## Rollback

- disable DSPy runtime flag and revert to existing LLM review engine path.
- retain compile/eval artifacts for diagnosis.
- keep deterministic gates and promotion policies unchanged.

## Acceptance Criteria

- At least one DSPy compile/eval/promotion cycle is executed via Jangar AgentRuns end-to-end.
- Jangar idempotency and policy checks pass for DSPy lanes with no manual CRD patching.
- Runtime shadow pilot demonstrates schema-valid DSPy advisory outputs and deterministic fallback behavior.
- Promotion evidence includes DSPy artifact hash and evaluation report pointers.

## References

- DSPy official docs overview: https://dspy.ai/
- DSPy signatures: https://dspy.ai/learn/programming/signatures/
- DSPy modules: https://dspy.ai/learn/programming/modules/
- DSPy optimizers: https://dspy.ai/learn/optimization/optimizers/
- DSPy GitHub repository and release/citation index: https://github.com/stanfordnlp/dspy
- DSPy paper: https://arxiv.org/abs/2310.03714
- MIPRO paper: https://arxiv.org/abs/2406.11695
- GEPA paper: https://arxiv.org/abs/2507.19457
