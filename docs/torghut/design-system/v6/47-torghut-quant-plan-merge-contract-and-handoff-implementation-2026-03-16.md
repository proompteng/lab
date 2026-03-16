# Torghut Quant plan-stage merge contract and implementation handoff (2026-03-16)

## Summary

This document is the merged architecture contract for the `torghut-quant` plan stage.
It closes the current discovery-to-plan loop by selecting one control-plane resilience design and one profitability architecture design, defining explicit implementation scope, and publishing deterministic rollout/rollback expectations for both engineer and deployer.

Primary outcomes:

- Jangar: reduce blast-radius failures during rollout churn by isolating segment-specific health and by making rollout transitions explicit and scoped.
- Torghut: increase measurable profitability potential through evidence- and budget-governed hypothesis lanes with automatic demotion behavior.
- Operations: preserve fast execution even under partial-surface failures through segment/lane-aware gating and bounded fallback.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base branch: `main`
- head branch: `codex/swarm-torghut-quant-plan`
- swarm name: `torghut-quant`
- swarm stage: `plan`
- owner channel: `swarm://owner/trading`

Success criteria for this mission are:

1. evidence-backed assessment for cluster, source, and database/data surfaces;
2. at least two ambitious architecture alternatives with tradeoffs and one selected per outcome domain;
3. merged implementation artifacts with measurable gates, rollout, and rollback expectations;
4. explicit handoff contract for engineer and deployer.

## Cluster/state assessment

### Rollout and health evidence (as observed on 2026-03-16)

- `kubectl get events -n torghut --field-selector type!=Normal --sort-by=.lastTimestamp` shows repeated rollout instability on the simulation and TA surfaces:
  - `torghut-sim-00239`, `torghut-sim-00240`, `torghut-sim-00241`, `torghut-sim-00242`: repeated readiness/startup probe failures and repeated `UpdateError`/`InternalError` reconciler conflicts around knative private service endpoints.
  - `torghut-ta-sim` and `flinkdeployments` show analysis/job exceptions and rapid update churn.
  - `ErrorNoBackup` for `torghut-db-restore` references missing backup `torghut/torghut-db-daily-20260310020000`.
- `kubectl get events -n jangar ...` shows one active `ErrorNoBackup` on `jangar-db-restore` and a transient pod readiness failure (`jangar` readiness probe timeout during startup recovery).
- `kubectl get events -n agents ...` shows `FailedMount` and repeated `BackoffLimitExceeded` for template pods (`codex-spark-smoke-*`, swarm discover/plan/verify templates), plus transient agent-controller readiness alerts.
- Pod snapshots show `Jangar` and `Torghut` control components mostly running, while simulation pods cycle through probe failures and retry windows.

### Control-plane resilience implication

The cluster is not in full incident lockout, but failure modes are clearly segment-correlated: same-time readiness jitter, knative rollout conflicts, and backup-lineage misses are interacting. Global-stop behavior from shared control predicates would increase blast radius.

## Source architecture assessment

### Jangar

- Existing status surfaces already carry dependency and rollout signals in:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/torghut-quant-runtime.ts`
  - `services/jangar/src/server/torghut-quant-metrics.ts`
- Existing control-plane semantics are sufficiently rich but still not yet implemented as segment-isolated lock semantics across all rollback and transition paths.
- Test coverage includes status helper behavior and controller primitives, but no comprehensive mixed-failure segment-rollback integration test matrix.

### Torghut

- Source already exposes hypothesis states and completion gates in:
  - `services/torghut/app/trading/hypotheses.py`
  - `services/torghut/app/completion.py`
  - `services/torghut/app/main.py`
  - `services/torghut/app/trading/empirical_jobs.py`
- The control-plane consumption path already has contract inputs for hypothesis, evidence, and capital data (`/trading/status`, `/trading/empirical-jobs`, `/db-check`) but lacks final per-hypothesis budget lineage outputs and strict lane continuity gating in all paths.

### Source-risk posture

- High-value coupling remains: a small degradation in one proof or rollout segment can currently influence broader scheduling/rollout behavior.
- Missing evidence: a single, merged reference contract that ties cluster-safe rollout control, hypothesis lane policy, and deployer actions into one explicit handoff artifact.

## Database and data posture assessment

- Data surfaces are present and queryable through API-contracts, but direct in-cluster DB reads are blocked by RBAC.
- Observed and code-exposed signals include:
  - schema checks and freshness checks in `services/torghut/app/main.py`;
  - empirical proof continuity logic and manifest hash/lineage validation scaffolding in `services/torghut/app/trading/empirical_jobs.py`.
- Runtime gaps remain:
  - missing backup lineage events (`ErrorNoBackup`) reduce confidence in continuity recovery windows,
  - empirical run evidence generation and continuity adoption is uneven across all hypothesis lanes.

## Architecture options and tradeoffs

### Jangar resilience alternatives

Option A: threshold-tuning only

- Low implementation cost.
- Keeps shared failure channels and does not reduce blast radius.

Option B: manual runbook-only gating

- Reduces automation burden but is slow and variable across shifts.

Option C: segment-aware control-plane gates and scoped rollbacks (selected)

- Adds explicit segment metadata (`discover`, `plan`, `verify`, `implement`) and segment-local gate decisions.
- Limits impact radius and creates deterministic scoped rollback actions.

### Torghut profitability alternatives

Option A: tighten global global gates only

- Limited gain; still uses implicit risk-sharing across hypotheses.

Option B: static manual capital buckets

- Predictable but too slow for changing market states.

Option C: hypothesis + evidence + capital mesh with kill/degrade transitions (selected)

- Per-hypothesis, per-lane budget limits.
- Automatic downgrades on repeated evidence decay or guardrail violation.

## Decision

Select Option C for both domains:

- Jangar uses segment-scoped rollout authority;
- Torghut uses hypothesis-lane profit governance with explicit deallocation and concentration limits.

## Merged implementation architecture (plan scope)

### 1) Segment-scoped control-plane contract (Jangar)

Define a control-plane payload segment envelope that includes:

- `segment` identity and `status` (`allow`, `warn`, `block`, `hold`);
- `dependency_quorum`, `watch_freshness`, `migration_consistency`, `rollout_pressure`;
- `gate_failures[]` with `reason`, `evidence_ref`, `recovery_condition`, `next_check_at`;
- `next_retry_at` and `last_recovery_at`.

Rollout behavior:

- gate decisions are applied to segment-local transitions only;
- `block` in one segment cannot freeze unrelated segments;
- repeated segment lock -> `hold` -> `cooldown` -> scoped `rollback`.

### 2) Profitability mesh contract (Torghut)

Define deterministic lane and budget state for each hypothesis:

- lifecycle: `shadow`, `canary`, `scaled`, `degrade`, `decommissioned`;
- inputs: expectancy, continuity ratio, freshness SLA, drawdown budget, concentration overlap, evidence lineage IDs;
- actions: `downgrade`, `pause_capital_scale`, `halt_live`, `kill_to_shadow`, `decommission`.

Gate rules:

- no live or scale-up transition without fresh, complete evidence windows;
- consecutive negative windows force demotion before global stop;
- anti-concentration constraints evaluated per regime and global budget.

### 3) Shared handoff contract

`/trading/status` and `/control-plane/status` must expose machine-readable, schema-stable records for:

- active segment state,
- hypothesis lane state,
- continuity score,
- active cap utilization,
- rollback lineage.

Deployer action contract:

- only one scope at a time is auto-escalated; healthy scope remains active if another scope is degraded,
- evidence IDs are mandatory for every rollback event.

## Validation gates

### Engineering gates (merge-precondition)

- Tests for mixed failure isolation across segments and hypothesis lanes.
- Contract-shape snapshots for Jangar segment status and Torghut lane state responses.
- Regression checks proving one segment/one lane can be blocked without forcing global lockout.

### Deployer gates (live rollout precondition)

- one market session with `observe -> gate -> dryrun` and no cross-surface freeze despite one local failure;
- one scoped rollback drill showing automatic demotion sequence and persisted reason lineage;
- proof windows verified before any canary scale-up with continuity below threshold blocked.

## Rollout and rollback expectations

Rollout cadence:

1. Shadow and compatibility mode for segment/lane schema updates.
2. Canister stage with mixed-failure simulations for 1 cycle.
3. Controlled canary for one hypothesis family under new mesh rules.

Rollback:

- if two consecutive critical blockages occur in one segment: hold + cooldown + operator alert;
- if two consecutive evidence violations occur for a live hypothesis: forced demotion to `degrade` then `shadow`;
- if market-control breach compounds with active loss-risk threshold breach: decommission and require explicit re-enablement.

## Handoff acceptance

Engineer handoff:

- segment-scoped segment gating code + tests in Jangar runtime and metric surfaces;
- hypothesis-lane transition + budget guards + demotion matrix in Torghut runtime;
- CI checks for changed JS/TS and Python surfaces run and pass.

Deployer handoff:

- runbook for scoped rollback drill and segment hold/cooldown.
- acceptance requires evidence of no global freeze when one segment is unhealthy and evidence of lane demotion within contract window.

## Merge references

- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
- `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
- `docs/torghut/design-system/v6/44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/45-torghut-quant-profitability-hypothesis-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md`

This document supersedes prior plan-stage notes by explicitly binding these references into a merged handoff contract.
