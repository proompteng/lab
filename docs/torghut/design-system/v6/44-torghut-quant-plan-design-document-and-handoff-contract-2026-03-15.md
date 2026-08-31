# 44. Torghut Quant Plan-Stage Architecture Design Document and Handoff Contract (2026-03-15)

## Status

- Date: `2026-03-15`
- Stage: `plan`
- Scope: cluster, source, and database assessment capture; concrete architecture decision closure; engineer and deployer handoff gates for the next implementation wave.
- Objective: assess current cluster/source/database state and operationalize the merged control-plane/profitability architecture for safe rollout.

## Objective and success metrics

- Mission runtime inputs:
  - `swarmName: torghut-quant`
  - `swarmStage: plan`
  - `ownerChannel conversation URI: swarm://owner/trading`
- Mandatory success metrics:
  1. evidence-backed assessment on all three surfaces: cluster rollout/events, source architecture risk surface, database/data quality/freshness.
  2. a merged architecture artifact set that includes options, tradeoffs, implementation scope, validation gates, and rollout/rollback expectations.
  3. explicit engineer handoff and deployer handoff acceptance criteria that can be tested by command/API outcomes.
  4. documented risks, next actions, and audit IDs for ticket/channel/doc issue artifacts.

## Cluster/state assessment

- Namespace/readiness baseline: `torghut`, `jangar`, and `agents` are observed with core pods running (service-plane stable, no cross-namespace crash-loop storm).
- Non-normal rollout evidence:
  - `torghut`:
    - `Unhealthy` readiness/liveness probe timeout for `torghut-00134-deployment...` windows.
    - `ErrorNoBackup` on `cluster/torghut-db-restore` referencing missing `torghut/torghut-db-daily-20260310020000`.
    - rapid `clickhouseinstallation` `UpdateCompleted` churn.
  - `jangar`:
    - `ErrorNoBackup` on `cluster/jangar-db-restore` referencing missing `jangar/jangar-db-daily-20260309110000`.
  - `agents`:
    - template/swarms failed to fetch absent configmaps in prior run (`FailedMount`, `BackoffLimitExceeded`), while active `torghut-swarm-*`/`jangar-swarm-*` jobs continued.
- RBAC and access limits observed in this session:
  - cannot list deployments/replicasets/secrets/clusters from service account context.
  - can-list and inspect core pods/events/services in target namespaces and read controller logs.

These signals imply localized control-plane/restore churn that can trigger broad readiness interpretation if not explicitly scoped.

## Source architecture assessment

- High-risk coupling points still visible from source:
  - `services/jangar/src/server/control-plane-status.ts`: historical watch jitter is still a potential shared-failure surface unless segment scoping is consumed consistently.
  - `services/jangar/src/server/torghut-quant-metrics.ts`: freshness confidence still depends on query-derived path if ledger confidence is absent.
  - `services/torghut/app/trading/hypotheses.py`: readiness is shared by hypothesis without full lane-safe rollback isolation in all paths.
- Coverage status:
  - tests exist for control-plane shadow behavior and hypothesis transitions.
  - missing coverage around mixed signal failures (`watch jitter` + healthy execution) and partial rollback behavior across hypotheses.

## Database/data assessment

- Endpoint evidence captured (`/readyz`, `/db-check`, `/trading/status`, `/trading/empirical-jobs`) indicates:
  - schema appears current (`schema_current=true`) in recent snapshots.
  - `promotion_eligible_total` is zero with recurring evidence blockers (`feature_rows_missing`, `evidence_continuity_missing`, `signal_lag_exceeded`).
  - empirical job families are absent in runtime and recurring proof input is not yet driving promotions.
- Data quality implication:
  - control decisions are constrained by evidence incompleteness and noisy continuity measurements more than by direct migration mismatch.

## Architectural options and tradeoff summary

### Option 1: tuned global controls only

- Pros: low change surface, lower operational risk.
- Cons: does not reduce common-mode coupling; one noisy channel still degrades all hypothesis stages.

### Option 2: global simplification into one control-plane authority

- Pros: simpler owner/operator model.
- Cons: raises blast radius and removes hypothesis-level resilience under partial data failure.

### Option 3: scoped control-plane segments plus hypothesis profitability lanes (selected)

- Pros: explicit blast-radius boundaries for rollout, explicit profitability progression with lane-scoped demotion, and evidence-first rollout gates.
- Cons: more complex policy model and stricter observability requirements in first release.

## Decision

Adopt Option 3 as the live plan-stage contract:

1. Keep merged discover-stage architecture as the authority baseline (segment contract + proof-lane baseline already merged in PRs 4496, 4497, 4498, 4499).
2. Formalize explicit plan-stage implementation lanes and acceptance gates to prevent this stage from remaining in design-only territory:
   - mixed-failure isolation,
   - scoped rollout behavior,
   - deterministic demotion,
   - operational rollback guardrails.

## Implementation contract for this plan-stage cycle

### Wave P1 — Scope and segment enforcement (engineering)

- Wire and retain segment outputs with confidence/scoped reasons in Jangar and Torghut payloads:
  - `dependency_quorum`, `control_runtime`, `freshness_authority`, `evidence_authority`, `market_data_context`.
- Add mixed-surface test cases for partial-failure behavior and segment-aware promotion logic.
- Hard requirement: global promotion lock is never caused by a single localized segment unless it is the only active proof carrier for the target hypothesis family.

### Wave P2 — Profitability gate modernization (engineering)

- Make lane state machine and budget updates visible at hypothesis granularity:
  - shadow/canary/live lane objects with deterministic budget utilization.
- Keep proof windows explicit and independent:
  - hypothesis readiness requires feature coverage, continuity, market context, and empirical-family freshness for that lane.
- Hard requirement: one hypothesis can continue safely in canary/rolled state while another remains blocked.

### Wave P3 — Controlled rollout and rollback choreography (engineering + deployer)

- Implement staged mode transitions with operator controls:
  - `observe -> gate -> dryrun -> full`.
- Roll back only the affected segment/lane on mismatch windows; preserve healthy lanes.
- Hard requirement: rollback actions are logged with reason lineage and evidence IDs.

## Validation gates

### Automated gates (to be executed by engineer)

- segment-to-lane mapping tests for mixed failures (unit+service tests).
- contract-shape snapshots for both `/api/agents/control-plane/status` and `/trading/status`.
- regression test that `watch` jitter does not force global lock when `freshness` + `evidence` remain healthy for unaffected hypotheses.

### Live gates (to be executed by deployer)

- one full market session under `observe -> gate` with no global freeze when one segment is degraded.
- one controlled `dryrun` window showing deterministic rollback lineage and scoped reversions.
- `promotion_eligible_total` transitions only where evidence-family completeness exists; no cross-hypothesis bleed.

## Rollout and rollback expectations

- Rollout progression rule:
  1. Wave P1 in shadow or compatibility mode.
  2. Wave P2 with capped hypothesis canary.
  3. Wave P3 with scoped hard rollback controls.
- Rollback triggers:
  - two consecutive session-level mismatches between legacy and scoped outputs,
  - sustained contradictory evidence on healthy hypotheses,
  - repeated false-negative lockouts or unsafe cap utilization with unresolved blocker lineage.

## Risks

- policy complexity from per-segment policy trees,
- operator interpretation drift without strict handoff checklists,
- proof-lane over-sensitivity during sparse data windows.

## Handoff

### Engineer acceptance

- segment-scoped authority contract implemented with test coverage,
- hypothesis lane transitions persisted and exposed in `/trading/status` and control-plane surfaces,
- rollback lineage and deactivation reasons are deterministic and machine-readable.

### Deployer acceptance

- one session evidence of scoped rollout with no global freeze on a localized segment fault,
- one session of planned rollback drill with one-lane reversal and clean recovery evidence,
- runbook checks updated for mixed-failure and lane rollback.

## Merged documents and follow-up

- Prior merged plan seed:
  - `docs/torghut/design-system/v6/42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
  - `docs/torghut/design-system/v6/42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
  - `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
  - `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
  - `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`

This document is the plan-stage closure for those merged discover decisions.
