# 62. Jangar Execution Receipts and Stage Recovery Cells Contract (2026-03-20)

Status: Approved for implementation (`discover`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`

Extends:

- `61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`
- `61-jangar-runtime-kit-ledger-and-execution-class-admission-contract-2026-03-20.md`
- `60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`

## Executive summary

The decision is to stop treating runtime completeness as an implied property of rollout health and to publish two
durable Jangar artifacts instead: **Execution Receipts** and **Stage Recovery Cells**.

The evidence from `2026-03-20` is decisive:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `200`;
  - still reports `execution_trust.status="degraded"`;
  - still cites unreconciled March 11, 2026 freeze expiry and `requirements.pending=5`.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - reports `rollout_health.status="healthy"` for `agents` and `agents-controllers`;
  - still reports `execution_trust.status="degraded"` because `jangar-control-plane` and `torghut-quant` remain
    frozen on `StageStaleness`.
- `kubectl -n agents logs pod/jangar-control-plane-torghut-quant-req-00gbjlqs-1-rpx2-c45gnd8d --tail=120`
  - fails on `python3: can't open file '/app/skills/huly-api/scripts/huly-api.py'`.
- `services/jangar/scripts/codex/lib/huly-api-client.ts`
  - still resolves the Huly helper from a repo-relative filesystem path;
  - the control plane does not persist whether that helper is actually present in the admitted runtime.

The tradeoff is more additive persistence and one more compiler layer. I am keeping that trade because the next
six-month failure mode is not "pods are down." It is "pods are serving while the work they admitted still cannot run."

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience, safer rollout, and Torghut profitability

This document succeeds when:

1. every Jangar execution class can cite one `execution_receipt_id` and one `stage_recovery_cell_id` instead of
   relying on broad degraded or blocked reducers;
2. missing runtime assets such as `/app/skills/huly-api/scripts/huly-api.py` become first-class control-plane debt
   before the next requirement or handoff job is admitted;
3. `/ready`, `/api/agents/control-plane/status`, requirement launchers, and deploy verification all expose the same
   receipt and recovery-cell identifiers;
4. stale freeze debt can block only the affected execution classes while serving and unrelated consumers remain
   explicitly healthy.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster now separates serving from execution badly enough that a new contract is required.

- `kubectl -n jangar get pods`
  - shows `jangar-c9bc8497-mkzl9` `2/2 Running`;
  - shows `jangar-worker-5864548487-cmrvv` `1/1 Running`.
- `kubectl -n jangar get events --sort-by=.lastTimestamp | tail -n 40`
  - shows the current `c474fc44` rollout completing;
  - also shows a readiness probe refusal during startup.
- `kubectl -n agents get swarm jangar-control-plane torghut-quant -o json`
  - still shows `status.freeze.until` values from `2026-03-11`;
  - still shows `jangar-control-plane.requirements.pending=5`.
- `GET /api/agents/control-plane/status`
  - reports rollout healthy while execution trust remains degraded.

Interpretation:

- rollout safety and runtime completeness are no longer the same problem;
- March 11, 2026 stale-stage debt and missing runtime assets are being flattened into one generic degraded answer;
- that flattening is now a control-plane reliability bug.

### Source architecture and test-gap evidence

The current code shape still leaves runtime executability implicit.

- `services/jangar/src/routes/ready.tsx`
  - returns `200` whenever execution trust is not `blocked` or `unknown`;
  - does not distinguish `serving`, `handoff`, `planner`, `implementer`, or `deployer` classes.
- `services/jangar/src/server/control-plane-status.ts`
  - computes rollout health, database health, watch reliability, dependency quorum, and execution trust in one
    request-time document;
  - does not persist the runtime components that made a class admissible.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still carries process-local `swarmUnfreezeTimers`;
  - stale-stage repair remains a behavior, not a durable recovery object.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - verifies Argo health and digest parity;
  - cannot verify runtime completeness or execution-class parity.

Architectural test gaps:

- no regression proves a missing Huly helper blocks only cross-swarm handoff while Jangar serving remains healthy;
- no parity test proves `/ready`, status, and deploy verification cite the same receipt ids;
- no restart test proves stale-stage repair survives controller restart without losing recovery ownership.

### Database, schema, freshness, and consistency evidence

Jangar already has enough persistent substrate to hold additive execution truth.

- `GET /api/agents/control-plane/status`
  - reports database healthy and current;
  - reports migrations applied and registered in parity.
- live worker RBAC still forbids direct `pods/exec` into the CNPG pod;
- the correct move is therefore additive application persistence, not wider operator access.

Interpretation:

- this is not a schema-drift problem;
- it is a control-plane modeling problem;
- the database is healthy enough to carry receipt and recovery-cell state safely.

## Alternatives considered

### Option A: patch the Huly helper path and keep the current reducers

Pros:

- fastest local fix;
- removes the current visible failure.

Cons:

- the next missing helper, secret mount, or binary repeats the same failure;
- rollout health and execution safety remain conflated;
- deploy verification still cannot prove runtime completeness.

Decision: rejected.

### Option B: split more images and runtimes without new control-plane objects

Pros:

- narrows blast radius operationally;
- keeps implementation localized to packaging and manifests.

Cons:

- correctness still lives in image conventions rather than control-plane truth;
- serving, launchers, and deploy tools still have no shared receipt to trust;
- stale-stage debt remains broad and request-time.

Decision: rejected.

### Option C: execution receipts plus stage recovery cells

Pros:

- makes runtime completeness a durable contract;
- scopes stale-stage debt to the classes it actually affects;
- gives deployers one digest/receipt pair to verify before promotion;
- preserves option value for new execution classes.

Cons:

- adds new tables and compiler work;
- requires a shadow rollout before enforcement.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile execution receipts per execution class and stage recovery cells per stale or failed stage window.
Admission and rollout can only trust the classes whose receipts are fresh and whose recovery cells are resolved or
explicitly tolerated.

## Architecture

### 1. Execution receipts

Add additive persistence:

- `control_plane_execution_receipts`
  - `execution_receipt_id`
  - `execution_class` (`serving`, `handoff`, `plan`, `implement`, `verify`, `deploy`)
  - `subject_ref`
  - `image_digest`
  - `workspace_digest`
  - `required_components_json`
  - `observed_components_json`
  - `decision` (`healthy`, `degraded`, `blocked`, `unknown`)
  - `reason_codes_json`
  - `observed_at`
  - `fresh_until`

Rules:

- every execution class is compiled independently;
- helper-path presence, required secrets, binaries, and mount contracts are part of the receipt;
- receipts are refreshed by lightweight shadow rehearsals on the promoted revision before rollout widening;
- receipt ids are stable enough to be cited by routes, launchers, and deploy verification.

### 2. Stage recovery cells

Add additive persistence:

- `control_plane_stage_recovery_cells`
  - `stage_recovery_cell_id`
  - `swarm_name`
  - `stage_name`
  - `failure_family` (`stage_staleness`, `runtime_missing_component`, `dependency_backoff`, `rollout_skew`)
  - `blocking_scope_json`
  - `opened_at`
  - `deadline_at`
  - `owner_ref`
  - `repair_action`
  - `evidence_json`
  - `resolved_at`
  - `closure_digest`

Rules:

- stale March 11, 2026 freeze debt becomes an explicit recovery cell instead of an immortal freeze timestamp;
- cells are durable across controller restarts;
- serving can remain healthy while `handoff` or `plan` stays blocked if only those scopes are affected.

### 3. Control-plane projection

Implementation surfaces must consume the new objects:

- `services/jangar/src/routes/ready.tsx`
  - reports serving-class receipt id and serving recovery-cell summary;
- `services/jangar/src/server/control-plane-status.ts`
  - reports per-class receipt and recovery-cell summaries;
- `services/jangar/scripts/codex/codex-implement.ts`
  - refuses to launch cross-swarm handoff when the `handoff` receipt is blocked;
- `packages/scripts/src/jangar/verify-deployment.ts`
  - verifies deployment digest parity and required receipt parity together.

## Validation, rollout, and rollback

Engineer acceptance gates:

1. Add unit coverage proving a missing Huly helper yields `handoff` blocked while `serving` stays healthy.
2. Add parity coverage proving `/ready`, `/api/agents/control-plane/status`, and deploy verification expose the same
   `execution_receipt_id`.
3. Add replay coverage proving stale-stage recovery cells survive controller restart and clear when the underlying
   cause is repaired.

Deployer acceptance gates:

1. `curl -sS http://jangar.jangar.svc.cluster.local/ready | jq '.execution_trust, .execution_receipts'`
2. `curl -sS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.execution_receipts, .stage_recovery_cells, .rollout_health'`
3. `kubectl -n agents get swarm jangar-control-plane torghut-quant -o json | jq '.items[].status.freeze, .items[].status.stageStates'`
4. no rollout promotion while any required receipt is `blocked` or any required recovery cell is unresolved past its
   deadline.

Rollout plan:

1. shadow-write receipts and recovery cells while existing reducers remain authoritative.
   Rehearse the required execution classes on the promoted revision before widening rollout.
2. project ids on status routes and deploy verification without enforcing them;
3. enforce `handoff`, `plan`, `implement`, and `verify` classes first;
4. enforce serving-class receipts only after shadow parity is stable.

Rollback plan:

- disable receipt enforcement and fall back to current reducer-based admission;
- keep writing receipt and recovery data for forensic comparison;
- do not delete recovery-cell history during rollback.

## Risks and open questions

- Runtime probes must stay lightweight; if probe cost is too high, receipt freshness could become the new bottleneck.
- Receipt class boundaries need discipline or the system will recreate a broad global gate under new names.
- Recovery ownership must stay explicit; unresolved cells without owners will simply reintroduce stale debt in a more
  formal table.
