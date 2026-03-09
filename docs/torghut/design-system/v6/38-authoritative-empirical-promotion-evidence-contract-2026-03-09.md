# 38. Authoritative Empirical Promotion Evidence Contract (2026-03-09)

## Status

- Date: `2026-03-09`
- Maturity: `implementation contract`
- Scope: `services/torghut/app/trading/{parity.py,empirical_jobs.py,completion.py}`, `services/torghut/app/trading/autonomy/{janus_q.py,lane.py,policy_checks.py}`, `services/torghut/scripts/run_empirical_promotion_jobs.py`, `services/torghut/tests/**`, and operator-facing empirical status surfaces
- Depends on:
  - `05-evaluation-benchmark-and-contamination-control-standard.md`
  - `08-profitability-research-validation-execution-governance-system.md`
  - `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
  - `32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
- Implementation status: `Partial`
- Primary objective: turn empirical promotion from durable-but-partially-scaffolded into promotion-authoritative evidence without redesigning already-landed control-plane machinery

## Context

The repository already has the outer control-plane surfaces needed for empirical promotion:

- empirical manifest normalization and validation;
- `workflowtaskresults` RBAC;
- persisted `vnext_empirical_job_runs`;
- persisted `VNextPromotionDecision`;
- `/trading/empirical-jobs` and `/trading/completion/doc29` operator surfaces;
- canonical rollout phase manifests and runtime governance append paths.

Those are not the missing design problem.

The missing design problem is narrower:

- `services/torghut/app/trading/parity.py` still emits deterministic scaffold authority for benchmark and foundation-router parity;
- `services/torghut/app/trading/autonomy/janus_q.py` still emits scaffold authority for Janus event/CAR and HGRM reward artifacts;
- the empirical script and persistence layer exist, but they need one explicit contract that says which artifacts are authoritative, how truthfulness is decided, and which existing write surfaces remain canonical.

This document is that contract.

## Non-goals

- replacing the existing `torghut-empirical-promotion-manifest-v1` envelope;
- adding a new top-level database table for empirical authority;
- redesigning rollout phase manifests or promotion-decision persistence;
- deleting scaffold builders that are still useful for local development or contract tests;
- defining the recurring prove-and-promote scheduler itself.

Recurring automation remains the next follow-on implementation wave, but this document is only about authoritative
empirical evidence.

## Decision

The implementation contract is:

1. the existing empirical promotion manifest, job persistence table, and operator status endpoints remain canonical;
2. deterministic scaffold producers remain allowed only for non-authoritative local/test scaffolding and must never satisfy promotion authority;
3. authoritative empirical promotion evidence is assembled only through `services/torghut/scripts/run_empirical_promotion_jobs.py` and persisted through `services/torghut/app/trading/empirical_jobs.py`;
4. benchmark parity and foundation-router parity authoritative artifacts must be produced by the existing empirical builders, not by the deterministic scaffold builders in `parity.py`;
5. Janus event/CAR, HGRM reward, and Janus-Q summary must be replay- or observed-window-derived artifacts whose authority is upgraded through the empirical promotion path, not left in scaffold mode;
6. no paper/live promotion path may consume a payload whose authority contract reports placeholder or non-authoritative provenance.

## Canonical implementation boundary

### Keep and reuse

These surfaces are already correct enough to remain the canonical write/read boundary:

- `services/torghut/app/trading/empirical_jobs.py`
- `services/torghut/scripts/run_empirical_promotion_jobs.py`
- `services/torghut/app/trading/completion.py`
- `services/torghut/app/main.py`
- `services/torghut/app/trading/autonomy/lane.py`
- `services/torghut/app/trading/autonomy/phase_manifest_contract.py`

### Do not reuse for promotion authority

These surfaces may remain in-tree, but their direct outputs must not be treated as promotion-authoritative:

- `services/torghut/app/trading/parity.py` deterministic benchmark parity report generation
- `services/torghut/app/trading/parity.py` deterministic foundation-router parity report generation
- `services/torghut/app/trading/autonomy/janus_q.py` scaffold authority defaults

## Contract set

### 1. Required authoritative artifact families

The empirical promotion path must treat these as the minimum authoritative artifact set:

| Job family | Persisted `job_type` | Canonical artifact ref | Canonical builder |
| --- | --- | --- | --- |
| Benchmark parity | `benchmark_parity` | `gates/benchmark-parity-report-v1.json` | `build_empirical_benchmark_parity_report(...)` |
| Foundation-router parity | `foundation_router_parity` | `router/foundation-router-parity-report-v1.json` | `build_empirical_foundation_router_parity_report(...)` |
| Janus event/CAR | `janus_event_car` | `gates/janus-event-car-v1.json` | `build_janus_event_car_artifact_v1(...)` then `promote_janus_payload_to_empirical(...)` |
| Janus HGRM reward | `janus_hgrm_reward` | `gates/janus-hgrm-reward-v1.json` | `build_janus_hgrm_reward_artifact_v1(...)` then `promote_janus_payload_to_empirical(...)` |

In addition, the run must emit:

- `gates/janus-q-evidence-v1.json`

`janus-q-evidence-v1.json` is a required companion summary artifact for operator inspection and completion tracing, but
the persisted empirical freshness rows remain keyed by `janus_event_car` and `janus_hgrm_reward`.

### 2. Manifest contract

This wave does **not** introduce a new manifest schema version.

The authoritative assembler continues to consume:

- `schema_version=torghut-empirical-promotion-manifest-v1`
- `run_id`
- `candidate_id`
- `dataset_snapshot_ref`
- `artifact_prefix`
- `strategy_spec_ref`
- `runtime_version_refs`
- `model_refs`
- `authority.generated_from_simulation_outputs=true`

Required family sections remain:

- `benchmark_parity`
- `foundation_router_parity`
- `janus_event_car`
- `janus_hgrm_reward`

`janus_q` may be supplied directly, but the existing normalizer-derived behavior remains canonical:

- if `janus_q` is absent and both Janus child artifacts are present, normalization may derive `janus_q`;
- validation still requires the Janus child artifacts to exist explicitly.

This means implementation should extend the current manifest contract, not replace it.

### 3. Authority contract

Every authoritative empirical artifact must satisfy all of the following:

1. `artifact_authority.provenance` is one of:
   - `historical_market_replay`
   - `paper_runtime_observed`
   - `live_runtime_observed`
2. `artifact_authority.maturity = empirically_validated` when `promotion_authority_eligible=true`
3. `artifact_authority.authoritative = true`
4. `artifact_authority.placeholder = false`
5. `promotion_authority_eligible = true`
6. `lineage.dataset_snapshot_ref` is non-empty
7. `lineage.job_run_id` is non-empty
8. `lineage.runtime_version_refs` contains at least one stable runtime ref
9. `lineage.model_refs` contains at least one stable model/spec ref

Any artifact that fails one of these rules may still be persisted for diagnosis, but it must be written as:

- `status=degraded` or `blocked`
- `authority=blocked`
- `promotion_authority_eligible=false`

### 4. Family-specific eligibility rules

#### Benchmark parity

Benchmark parity remains authoritative only through `build_empirical_benchmark_parity_report(...)`.

Eligibility rules:

1. all required benchmark families are present;
2. all required scorecards exist;
3. every required scorecard has `status=pass`;
4. `dataset_snapshot_ref` is non-empty.

The deterministic builder in `parity.py` remains non-authoritative by contract and must continue to surface
`blocked_missing_empirical_authority`.

#### Foundation-router parity

Foundation-router parity remains authoritative only through `build_empirical_foundation_router_parity_report(...)`.

Eligibility rules:

1. `overall_status=pass`;
2. all required adapters are present;
3. `dataset_snapshot_ref` is non-empty.

The deterministic foundation-router report in `parity.py` must remain explicitly non-authoritative.

#### Janus event/CAR and HGRM reward

Janus base builders may continue to compute event and reward payloads, but their initial scaffold authority is not
promotion-safe.

The authoritative path is:

1. build replay- or observed-window Janus payloads;
2. upgrade each payload through `promote_janus_payload_to_empirical(...)`;
3. persist the upgraded payloads through `upsert_empirical_job_run(...)`.

Eligibility rules for the upgraded Janus artifacts:

1. the underlying payload contains a non-empty `summary`;
2. `dataset_snapshot_ref` is non-empty;
3. the upgraded payload passes the authority contract in section 3.

#### Janus-Q summary

`janus-q-evidence-v1.json` becomes authoritative only when **both** underlying Janus artifacts are already truthful.

This is an explicit implementation requirement. `summary_payload.promotion_authority_eligible` must be derived from:

1. `event_count > 0`
2. `reward_count > 0`
3. `event_mapped_count >= reward_count`
4. upgraded event/CAR payload is truthful
5. upgraded HGRM reward payload is truthful

A Janus summary must not mark itself authoritative when the two underlying Janus artifacts are still blocked,
placeholder, or non-authoritative.

### 5. Persistence contract

`VNextEmpiricalJobRun` remains the single persistence surface for empirical freshness and authority by job family.

Implementation requirements:

1. every required family writes one latest row keyed by `job_run_id`;
2. `authority` is set to `empirical` only when the payload is truthful under `_artifact_is_truthful(...)`;
3. `artifact_refs` include the authoritative family artifact ref;
4. Janus family rows also include the shared Janus summary ref in `artifact_refs`;
5. no new table is required for v1 of this contract.

`VNextPromotionDecision` remains unchanged in this wave. Promotion decisions continue to read empirical job freshness and
authority from the existing status/policy surfaces.

### 6. Completion and operator surfaces

The following surfaces remain canonical and must be updated only to reflect truthful empirical rows, not replaced:

- `/trading/empirical-jobs`
- `/trading/completion/doc29`
- `DOC29_EMPIRICAL_JOBS_GATE`
- `promotion_truthfulness_firewall`

Required behavior:

1. `/trading/empirical-jobs` reports `ready=true` only when all required job families are fresh, `authority=empirical`,
   and `promotion_authority_eligible=true`;
2. `/trading/completion/doc29` must not report empirical-job satisfaction from scaffolded parity/Janus payloads;
3. operators must be able to explain a `block` or `degrade` outcome from persisted rows and artifact refs without log
   archaeology.

### 7. Failure semantics

The contract fails closed under any of these conditions:

- artifact authority missing;
- artifact authority still scaffolded/synthetic;
- dataset snapshot ref missing;
- required family missing;
- required Janus child artifact missing or non-truthful;
- stale empirical job row;
- artifact hash present but payload not promotion-authority-eligible.

Failure result:

- persist the degraded/blocked artifact anyway;
- write the empirical job row;
- keep `authority=blocked`;
- keep `promotion_authority_eligible=false`;
- block paper/live promotion.

## Implementation plan

### Step 1. Benchmark and foundation-router authority swap

Ownership:

- `services/torghut/app/trading/parity.py`
- `services/torghut/app/trading/empirical_jobs.py`
- `services/torghut/scripts/run_empirical_promotion_jobs.py`

Required changes:

1. keep deterministic builders in `parity.py` explicitly scaffold-only;
2. ensure promotion paths and empirical job assembly use only the empirical builders;
3. add regression coverage that scaffold reports can never satisfy promotion authority.

### Step 2. Janus authority upgrade

Ownership:

- `services/torghut/app/trading/autonomy/janus_q.py`
- `services/torghut/app/trading/empirical_jobs.py`
- `services/torghut/scripts/run_empirical_promotion_jobs.py`

Required changes:

1. preserve the existing Janus payload computation logic;
2. stop treating replay-derived Janus payloads as scaffold authority in the empirical promotion path;
3. make Janus summary authority depend on the truthfulness of both upgraded child artifacts.

### Step 3. Completion and status hardening

Ownership:

- `services/torghut/app/trading/completion.py`
- `services/torghut/app/main.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`

Required changes:

1. ensure completion and policy checks cannot pass from scaffold parity/Janus artifacts;
2. ensure stale or blocked empirical rows are surfaced clearly in status payloads;
3. keep the existing endpoints and gate ids stable.

### Step 4. Tests

Minimum regression suite:

- `services/torghut/tests/test_empirical_jobs.py`
- `services/torghut/tests/test_feature_parity.py`
- `services/torghut/tests/test_policy_checks.py`
- `services/torghut/tests/test_trading_api.py`
- `services/torghut/tests/test_completion_trace.py`
- `services/torghut/tests/test_janus_q_scaffold.py`

Minimum validation command set:

```bash
uv run --frozen pytest \
  tests/test_empirical_jobs.py \
  tests/test_feature_parity.py \
  tests/test_policy_checks.py \
  tests/test_trading_api.py \
  tests/test_completion_trace.py \
  tests/test_janus_q_scaffold.py -q
```

## Exit criteria

This contract is implemented when all of the following are true:

1. benchmark parity and foundation-router parity promotion authority can only be satisfied through empirical builders;
2. Janus event/CAR, HGRM reward, and Janus summary can only become authoritative from replay- or observed-window data;
3. `/trading/empirical-jobs` reports readiness only from truthful empirical rows;
4. `/trading/completion/doc29` no longer has a path to satisfied state through scaffold parity/Janus payloads;
5. engineers can implement and test the full slice without inventing new persistence or orchestration surfaces.
