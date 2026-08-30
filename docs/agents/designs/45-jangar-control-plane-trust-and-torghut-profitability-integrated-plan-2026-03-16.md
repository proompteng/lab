# 45. Jangar Control-Plane Trust and Torghut Profitability Integrated Plan (2026-03-16)

Status: Proposed for implementation (`plan`)

## Objective

Assess cluster/source/database state for `jangar-control-plane` and `torghut-quant`, then define an integrated `plan`-stage architecture set that reduces Jangar failure blast radius and increases Torghut profitability certainty with measurable gates.

Current mission context:

- repository: `proompteng/lab`
- base branch: `main`
- head branch: `codex/swarm-jangar-control-plane-plan`
- swarm: `jangar-control-plane`
- stage: `plan`

## Cluster assessment

Observed via read-only Kubernetes inspection (UTC timestamps shown below):

- `kubectl get ns agents jangar torghut --no-headers` shows all three namespaces `Active`.
- `kubectl get swarms jangar-control-plane torghut-quant -n agents -o wide`
  - `jangar-control-plane`: `PHASE=Frozen`, `MODE=lights-out`, `READY=False`
  - `torghut-quant`: `PHASE=Frozen`, `MODE=lights-out`, `READY=False`
- `kubectl get agentrun -n agents`
  - `jangar-swarm-discover-template` / `plan-template` currently `Running`
  - `jangar-swarm-implement-template` and `jangar-swarm-verify-template` `Failed` (`BackoffLimitExceeded` on verify history)
  - `torghut-swarm-discover-template` currently `Running`
  - `torghut-swarm-plan-template`, `torghut-swarm-verify-template` `Failed`
- `kubectl get jobs -n agents --field-selector status.successful=0` shows prior failed rollout jobs including:
  - `jangar-swarm-verify-template-step-1-attempt-1`
  - `torghut-swarm-plan-template-step-1-attempt-1`
  - `torghut-swarm-verify-template-step-1-attempt-1`
- `kubectl get pods -n agents --sort-by=.status.startTime` shows mixed-state execution: core controller pods running and job pods in `Error`/`Running` states (e.g., `jangar-swarm-discover-template-step-1-attempt-1-*`, `jangar-swarm-verify-template-step-1-attempt-1-*`, `torghut-swarm-plan-template-step-1-attempt-1-*`).
- `kubectl get events -n agents --field-selector type!=Normal` currently returns none in the sampled window, so failure state is best represented by stale/failure-stage status rather than active warning spam.

Interpretation:

- The control plane has partial orchestration liveness with meaningful stage-level staleness/freeze, which means implicit local-controller-ready signals are insufficient as a single source of truth.
- Rollout safety should be made segment-aware so one failed template stage does not imply global unsafe progression.

### Rollout behavior evidence links

- `https://kubernetes.io/docs/concepts/workloads/controllers/job/` for failed job lifecycle semantics
- `kubectl get event` snapshots (collected in-session) for `agents` namespace
- `kubectl describe`/status snapshots of failed `*-verify-template` jobs (noisy signals not always retained in short event windows)

## Source assessment

### Jangar high-risk modules

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/routes/ready.tsx`
- `services/jangar/src/server/control-plane-watch-reliability.ts`
- `services/jangar/src/server/orchestration-controller.ts`

Risk posture:

1. Current stage truth (`discover/plan/implement/verify`) is present but not fully normalized into a single execution-trust contract consumed by readiness and rollout predicates.
2. Failure semantics are coarse at the global level, reducing observability for mixed-stage failures.
3. Recovery and anti-flap thresholds are not fully deterministic across all pathways in these modules.

### Torghut high-risk modules

- `services/torghut/app/trading/hypotheses.py`
- `services/torghut/app/completion.py`
- `services/torghut/app/trading/empirical_jobs.py`
- `services/torghut/app/main.py`
- `services/torghut/app/finance/risk.py`

Risk posture:

1. Profitability promotion uses multiple evidence paths but lacks per-hypothesis lane persistence of budget/continuity state for every transition.
2. Guardrail signals exist, but hypothesis-level failover/degrade behavior is not consistently enforced as deterministic control-plane contracts.
3. Missing test coverage around mixed-surface failures: one degraded lane should not force all hypothesis classes into global lock.

## Database / data / freshness assessment

Migration inventory confirms schema and execution artifacts exist for both domains:

- `services/torghut/migrations/versions/*` includes:
  - `0024_simulation_runtime_context.py`
  - `0021_strategy_hypothesis_governance.py`
  - `0011_autonomy_lifecycle_and_promotion_audit.py`
  - `0010_execution_provenance_and_governance_trace.py`
- `services/jangar/src/server/migrations/*` includes:
  - `20260308_agents_control_plane_component_heartbeats.ts`
  - `20260304_jangar_github_worktree_refresh_state.ts`
  - `20260312_torghut_simulation_control_plane.ts`
  - `20260209_agents_control_plane_cache.ts`

Current constraint:

- DB read permissions from the current agent context are constrained (no direct CNPG shell/exec path), so quality validation is performed through migration contracts, service status surfaces, and API-level completeness fields.
- This is acceptable for plan stage if the implementation adds explicit data-freshness and continuity references into control-plane payloads to make decisions auditable without manual DB traversal.

## Problem statement and design hypotheses

1. Jangar readiness and rollout continue despite stale/frozen stage behavior, risking unsafe autonomous progression.
2. Rollback behavior is not yet consistently scoped by segment, so one segment error can force coarse freeze posture.
3. Torghut profitability changes can promote under ambiguous evidence continuity because hypothesis budget/degrade lineage is not uniformly surfaced as machine-readable state.

## Ambitious options and tradeoffs

### Jangar execution safety options

1. Status-only observability
   - Pros: low implementation risk, fast.
   - Cons: does not remove failure-mode amplification, no deterministic hold/recovery gates.
2. Global block gates on any signal failure
   - Pros: safer than option 1 by defaulting to stop.
   - Cons: high false-positive risk; blocks unrelated healthy segments and reduces delivery velocity.
3. Segment-scoped execution trust with failure-classed gates (selected)
   - Pros: deterministic local holds/cooldowns, scoped recovery, lower blast radius.
   - Cons: higher control policy complexity and more test surface.

### Torghut profitability options

1. Tighten existing scalar gates only
   - Pros: quick, low code surface.
   - Cons: weak on lane-level evidence continuity and repeatable demotion.
2. Manual hypothesis review workflow
   - Pros: human-intuitive controls and governance.
   - Cons: slow and inconsistent under high-frequency loops.
3. Hypothesis lanes + capital/concentration mesh with demotion automata (selected)
   - Pros: explicit, composable profitability guardrails with measurable rollback.
   - Cons: requires stronger schema/state discipline and richer tests.

Decision: select option 3 for both domains.

## Proposed integrated architecture

### 1) Jangar: execution trust envelope v2

Introduce an explicit segment contract and classify per-stage state:

- `executionTrust`
  - `decision`: `healthy|degraded|blocked|unknown`
  - `confidence`: `high|medium|low`
  - `segmentBlocks[]`: per `discover|plan|implement|verify`, with `failureClass`, `reason`, `windowMs`, `evidenceRefs`
  - `rollbackPlan`: active `hold|cooldown|override`
- `swarms[]`: authoritative per-swarm fields (`phase`, `ready`, `freeze`, `requirementsPending`, per-stage staleness)
- `dependencySignals[]`: merged from watch reliability, cache freshness, and rollout pressure inputs

Rollout predicate for canary transitions:

- deny transition if any active segment is `blocked`
- allow `degraded` only for whitelisted transient classes with bounded cooldown
- require `executionTrust.decision==healthy` for canary increase operations

### 2) Torghut: profitability lane contracts + guardrails

Introduce deterministic lane/state representation in trading outputs and Jangar-facing status:

- `hypothesis.lane`: `shadow|canary|scale|degrade|decommissioned`
- `riskBudget`
  - `drawdown`, `reject_ratio`, `slippage_p95`, `concentration`
  - `continuity` and `evidenceFreshness`
- `proofLineage`
  - `hypothesis_id`, `completion_id`, `db_trace_id`, `continuity_gap`
- `degradePolicy`: forced demote after consecutive failures instead of hidden inference

### 3) Shared rollout/rollback contract

- scoped rollback (segment/lane granularity)
- explicit hold windows by failure class
- evidence-only clear conditions before unfreeze
- shared telemetry keys: `evidenceRefs`, `nextCheckAt`, `recoveryCondition`, `operatorOverrideTTL`

## Validation gates

### Engineer gates

- Unit/integration tests (Jangar):
  - segment freeze -> `executionTrust.decision=blocked`
  - transient one-shot failures remain `degraded` and recover after decay window
  - blocked segment does not allow canary weight advancement
- Unit/integration tests (Torghut):
  - hypothesis lane transitions are explicit and persisted
  - two consecutive breaches force `degrade`/`decommissioned`
  - continuity misses fail `canary->scale` and `scale->live` transitions
- Schema snapshot tests for both `/api/agents/control-plane/status` and `/trading/status`.

### Deployer gates

- `observe -> gate -> dryrun` session with one segment intentionally failed must keep unaffected segments actionable.
- scoped rollback drill must produce persisted lineage with reason + `evidenceRefs`.
- no global freeze on isolated segment or lane failure; only scoped hold/cooldown.

## Rollout and rollback expectations

Rollout stages:

1. shadow mode with read-only status enrichment
2. mixed-failure tests in staging with scoped holds enabled
3. production canary with rollback lineage monitoring

Rollback:

- segment or lane with repeated critical signals enters `hold` then `cooldown`.
- repeated evidence- and risk-breach while on live state demotes to `degrade` before incident escalation.
- freeze/unfreeze only when trust block reasons are reduced and evidence continuity is restored.

## Success metrics and exit criteria

- zero canary advancement when active blocked segment exists
- no global lockout from isolated segment or lane fail
- 100% promotion attempts include hypothesis ID, proof IDs, and continuity markers
- MTTR for mixed-failure recovery reduced by deterministic scoped rollback and hold windows in next two release cycles

## Risks and mitigations

- Implementation scope increases control-plane state complexity.
  - Mitigation: explicit schema snapshots, strict ownership comments, and staged rollout.
- Coverage burden in test matrix across languages.
  - Mitigation: contract test harness per surface, minimum matrix for each failure class.
- Incomplete continuity evidence until DB read access is broadened.
  - Mitigation: require immutable evidence references in all PRs and control-plane payloads.

## Merge-ready implementation scope (files)

- Jangar:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/routes/ready.tsx`
  - `services/jangar/src/server/orchestration-controller.ts`
  - `services/jangar/src/server/control-plane-watch-reliability.ts`
  - `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- Torghut:
  - `services/torghut/app/trading/hypotheses.py`
  - `services/torghut/app/completion.py`
  - `services/torghut/app/trading/empirical_jobs.py`
  - `services/torghut/app/main.py`
  - `services/torghut/app/trading` test module equivalents

## Merged references

- `docs/agents/designs/44-jangar-control-plane-segmented-failure-domain-and-safe-rollout-contract-2026-03-16.md`
- `docs/agents/designs/43-jangar-control-plane-execution-trust-safety-net-and-safe-rollout-2026-03-15.md`
- `docs/agents/designs/43-torghut-profitability-evidence-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/45-torghut-quant-profitability-hypothesis-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
