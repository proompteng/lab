# 16. DSPy LLM Live-Gate Root Cause and Rollout Plan (2026-03-04)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented/prototyped: LLM review, DSPy scripts, discovery stress modules, and Jangar OpenAI-compatible routes exist; many ML/LOB designs remain research/prototype.
- Matched implementation area: LLM, DSPy, AI review, and model governance.
- Current source evidence:
  - `services/torghut/app/trading/llm`
  - `services/torghut/scripts/run_dspy_workflow.py`
  - `services/torghut/scripts/compile_dspy_program.py`
  - `services/jangar/src/routes/openai/v1/chat/completions.ts`
  - `services/torghut/app/trading/discovery/order_flow_features.py`
- Design drift note: Distinguish production review gates from research/prototype model ideas.


## Usage note (2026-03-09)

This is a dated incident/root-cause and rollout document for the March 3-4 DSPy live-gate failure mode.

Read it as historical implementation rationale. Do not treat it as the current overall Torghut next-work priority or
the current autonomy/evidence source of truth.

## Incident Summary

Date observed: 2026-03-03 (UTC)

Live Torghut decision rejects were dominated by `llm_error`, with `llm_decision_reviews` showing:

- `rationale=llm_dspy_live_runtime_gate_blocked`
- guardrail reason `dspy_bootstrap_artifact_forbidden`

## Verified Root Cause Chain

1. Live runtime was configured as:
   - `LLM_DSPY_RUNTIME_MODE=active`
   - `LLM_DSPY_ARTIFACT_HASH=df087a5e...` (the bootstrap artifact hash)
2. Active mode forbids bootstrap hash by design, so every DSPy review was gate-blocked before LLM execution.
3. `llm_dspy_workflow_artifacts` had zero rows in production, so no promotable `dspy_live` artifact existed.
4. DSPy AgentRun lane prompts were not parameter-rendered:
   - ImplementationSpec text used `${...}` placeholders
   - prompt payload in `run.json` shipped placeholders literally
5. Torghut workflow contract had a promotion gap:
   - promote lane requires `artifactHash`
   - default script/orchestration path did not guarantee that value

## Design Goals

- Eliminate placeholder-driven non-deterministic lane execution.
- Enforce complete promote contract (`artifactHash`) in workflow orchestration.
- Persist runtime lineage metadata required by DSPy manifest loading.
- Preserve fail-closed safety in active live mode.

## Implemented Changes

### A. Jangar: render parameterized ImplementationSpec text

Files:

- `services/jangar/src/server/agents-controller/implementation-contract.ts`
- `services/jangar/src/server/__tests__/agents-controller-implementation-contract.test.ts`

Changes:

- Added prompt/body/title rendering for both template styles:
  - `{{parameters.foo}}`
  - `${foo}`
- Rendered values are now reflected in event payload prompt fields.

### B. Torghut: enforce promote artifact hash + persist executor lineage

Files:

- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
- `services/torghut/scripts/run_dspy_workflow.py`
- `services/torghut/tests/test_llm_dspy_workflow.py`
- `services/torghut/tests/test_run_dspy_workflow.py`

Changes:

- Promote lane now blocks early with explicit error if `artifactHash` is missing and cannot be derived from compile artifact evidence (`dspy_promote_artifact_hash_missing`).
- Workflow upsert now stamps `metadata_json.executor=dspy_live` when compile lineage is present.
- Orchestration attempts to load compile/eval/promotion artifact payloads from local artifact refs and persists available lineage fields on terminal updates.
- `run_dspy_workflow.py` now accepts `--artifact-hash` for promote lane contract completeness.

## Tomorrow Rollout Checklist

1. Merge this change set and deploy Torghut + Jangar.
2. Run DSPy workflow with real artifact refs and explicit promote hash.
3. Confirm `llm_dspy_workflow_artifacts` has at least one row with:
   - non-bootstrap `artifact_hash`
   - `metadata_json.executor=dspy_live`
   - `gate_compatibility=pass`
4. Update Torghut runtime `LLM_DSPY_ARTIFACT_HASH` to the promoted hash.
5. Verify live readiness:
   - no `dspy_bootstrap_artifact_forbidden`
   - `llm_error` no longer dominant rejection reason
   - successful `llm_decision_reviews` with DSPy runtime lineage.

## Rollback

If readiness checks fail:

1. Revert to last known stable revision.
2. Keep LLM fail mode strict-veto in active live rollout stages.
3. Re-run workflow with corrected artifact lineage evidence before re-promoting.
