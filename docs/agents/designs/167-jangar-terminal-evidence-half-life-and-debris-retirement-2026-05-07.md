# 167. Jangar Terminal Evidence Half-Life And Debris Retirement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane terminal evidence, retained failure accounting, database evidence carry, rollout admission,
rollback, validation gates, and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md`

Extends:

- `166-jangar-evidence-capability-ledger-and-observer-lease-gates-2026-05-07.md`
- `165-jangar-proof-settlement-broker-and-profit-repair-packet-gates-2026-05-07.md`
- `163-jangar-scoped-evidence-debt-and-retained-failure-quarantine-2026-05-07.md`
- `docs/torghut/design-system/v6/170-torghut-data-witness-capability-bonds-and-capital-observation-gates-2026-05-07.md`

## Decision

I am selecting a **terminal evidence half-life governor with debris retirement gates** as the next Jangar control-plane
architecture step.

The live state is better than the old NATS soak. Jangar, agents, and agents-controllers are rolled out on the current
image, recent hourly schedule CronJobs are completing, Jangar SQL is directly readable through the app credential, and
the control-plane status route reports healthy rollout, watch reliability, and database migration consistency. That is
real recovery. It is not enough to treat all retained failures as harmless history.

The cluster still has retained failed schedule jobs and pods from earlier waves. The agents API reports 384 AgentRuns,
including 19 failed and 4 running. Recent events still include readiness probe timeouts during rollout. The direct
Jangar database sample shows `agents_control_plane.resources_current` is fresh, but it only carries the current
control-plane resource snapshot, not a complete terminal debris ledger for Jobs, Pods, CronJobs, and historical failed
attempts. It also shows very high carry in Torghut-owned proof data, especially `torghut_control_plane.quant_pipeline_health`
at roughly 51 million live rows with no visible autovacuum or autoanalyze timestamp in the sampled stats.

The design answer is to make evidence age and terminal debris explicit. Green serving, green rollout, and fresh
current resources remain useful, but they cannot erase old failures until those failures are either retired with a
snapshot, bound to a known repaired class, or still inside a decay window that keeps them visible. Jangar should emit a
half-life ledger that says which terminal evidence still carries risk, which debris can be retired, which data surfaces
are too stale or too large to support material action, and which exact cleanup or proof action moves the gate.

The tradeoff is that this design makes the system less forgiving after a recovery. Operators will see old failure
debt for longer, and deployers will need to prove retirement instead of relying on Kubernetes history limits alone. I
am choosing that friction because it protects the next six months of the control plane: reliability improves when
terminal evidence decays under an explicit contract instead of disappearing when a deployment turns green.

## Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` emits `terminal_evidence_half_life`.
- Each ledger includes `ledger_id`, `namespace`, `generated_at`, `fresh_until`, `source_image`, `terminal_classes`,
  `debris_inventory`, `retirement_candidates`, `carry_budget`, `action_class_gates`, and `rollback_target`.
- Failed Jobs, failed Pods, failed AgentRuns, old-image running Jobs, readiness probe bursts, stale database witnesses,
  and oversized proof tables are reported as separate terminal classes.
- `serve_readonly` may remain allowed while debris carry is above budget if current rollout and database probes are
  healthy.
- `dispatch_repair` may run when the target terminal class is named and bounded.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, and Torghut capital handoff stay held while terminal carry exceeds
  budget or while a retained failure has no retirement snapshot.
- Retired debris is not deleted blindly. It must first have a durable snapshot with object identity, image digest,
  phase, reason, owner, first seen, last seen, and retirement reason.
- Deployer rollback has a single target: disable enforcement and return the ledger to advisory mode while preserving
  collection.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database
records, secrets, AgentRuns, GitOps resources, Torghut flags, or cluster state.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-jangar-control-plane-plan`, based on `main` at `bef4b3a79`.
- `kubectl config current-context` was unset, but explicit namespace reads worked through
  `system:serviceaccount:agents:agents-sa`.
- Jangar was rolled out: `deployment/jangar` was `1/1`, pod `jangar-6bc4f87fff-t2lz9` was `2/2 Running`, and the
  Jangar service endpoint pointed at that pod.
- Agents was rolled out: `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, and rollout status
  succeeded for both.
- Retained failed debris remained visible. The agents namespace still listed failed Jangar control-plane schedule
  CronJobs from the older wave, failed manual attempts that later succeeded on retry, and failed Torghut
  market-context jobs.
- Recent events showed improved schedule behavior, including completed Jangar plan CronJobs and completed Torghut
  quant CronJobs, but also readiness probe timeouts for old agents controller pods during rollout.
- Torghut was running on revision `torghut-00285` and `torghut-sim-00385`, but recent events showed startup and
  readiness probe failures during the revision transition, plus repeated ClickHouse PodDisruptionBudget ambiguity
  warnings.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is still the largest Jangar module at 3,315 lines.
  It owns schedule runner generation, CronJob and ConfigMap reconciliation, runtime admission refresh, swarm dispatch,
  requirement dispatch, workspace PVC lifecycle, and supporting primitive status.
- `services/jangar/src/server/primitives-kube.ts` now supports `PersistentVolumeClaim`, `pvc`, and `pvcs`, so the
  older workspace PVC read gap is closed. The remaining risk is not missing PVC mapping; it is terminal evidence
  carry across Jobs, Pods, AgentRuns, current resource snapshots, and database proof tables.
- `services/jangar/src/server/control-plane-status.ts` already assembles database, rollout, watch reliability,
  runtime admission, and execution trust. The half-life ledger should be another collector, not more logic inside the
  supporting controller.
- `services/jangar/src/server/control-plane-db-status.ts` validates app DB connectivity and migration consistency, but
  does not yet expose high-volume table carry, stale proof surfaces, or autovacuum/analyze freshness as material action
  inputs.
- The control-plane API summary reports AgentRuns, ImplementationSpecs, Schedules, Swarms, and other CRDs, while the
  SQL `resources_current` sample only showed current rows for AgentRun, ImplementationSpec, Agent, AgentProvider, and
  VersionControlProvider. That split is evidence debt until the data contract says which resource classes are expected
  in the persistent snapshot.

### Database And Data Evidence

- Direct Jangar SQL succeeded with the app credential from `jangar-db-app`, using a local `pg` client and no pod exec.
  `select current_database(), current_user, now()` returned database `jangar`, user `jangar`, and current time.
- Jangar status reported database `configured=true`, `connected=true`, migration consistency `healthy`, 28 registered
  migrations, 28 applied migrations, and latest applied `20260505_torghut_quant_pipeline_health_window_index`.
- Direct SQL confirmed the latest sampled Kysely migrations are the three Torghut quant pipeline health indexes from
  2026-05-05 plus the 4096-dimension embedding migration.
- `agents_control_plane.resources_current` had about 3,652 live rows and fresh autovacuum/autoanalyze, with current
  rows for 384 AgentRuns, 24 ImplementationSpecs, 8 Agents, 6 AgentProviders, and 1 VersionControlProvider.
- `agents_control_plane.component_heartbeats` showed orchestration-controller healthy, while workflow-runtime,
  agents-controller, and supporting-controller heartbeats were `disabled` from the Jangar app perspective. The live
  agents-controllers rollout is healthy, so the ledger must distinguish delegated rollout authority from app-local
  component heartbeat authority.
- `torghut_control_plane.quant_pipeline_health` had about 51,090,363 live rows and no sampled autovacuum or
  autoanalyze timestamp. `torghut_control_plane.quant_metrics_latest` was fresh and recently analyzed.
- Jangar-hosted market-context snapshots showed `news` fresh on 2026-05-07, but `fundamentals` had newest `as_of`
  2026-03-12 and newest update 2026-03-16.
- CNPG status and pod exec remain unavailable to this runtime: listing CNPG clusters in `jangar` was forbidden, and
  `kubectl cnpg psql` failed because `pods/exec` in `jangar` is forbidden.

## Problem

Jangar now has several ways to say the system is healthy. It can read current deployments, watch CRDs, query its app
database, and serve typed status. The failure mode has moved from broad invisibility to premature debt forgiveness.

There are three classes of evidence that need different treatment:

1. Current positive evidence, such as a ready deployment or fresh migration check.
2. Terminal negative evidence, such as failed Jobs, failed Pods, failed AgentRuns, old-image attempts, or readiness
   probe bursts.
3. Data carry evidence, such as stale market-context snapshots, oversized proof history, or persistent snapshots that
   do not cover every resource class used by the API.

If those classes collapse into a single green status, Jangar can dispatch normal work while old failures are still
unexplained. If they collapse into a single red status, Jangar blocks useful repair work even when the current system
is healthy. The control plane needs a decay model that keeps old failures visible long enough to guide repairs and
then retires them safely once a snapshot proves they are no longer actionable.

## Alternatives Considered

### Option A: Trust Kubernetes History Limits And Current Rollout

Let CronJob history limits, Job TTLs, and ready deployments decide when old failures stop mattering.

Advantages:

- Simple to operate.
- Aligns with Kubernetes cleanup primitives.
- Avoids new Jangar data and status payloads.

Disadvantages:

- Failed objects can disappear before a durable control-plane snapshot exists.
- Current rollout can hide old-image failures and retry-only successes.
- Torghut capital consumers cannot tell whether a failure was repaired, expired, or merely pruned.

Decision: reject as the material action contract.

### Option B: Freeze On Any Retained Failure

Hold dispatch, deploy widening, merge readiness, and capital handoff whenever any failed Job, Pod, or AgentRun exists.

Advantages:

- Conservative and easy to reason about.
- Forces cleanup work to happen.
- Prevents old failures from being ignored.

Disadvantages:

- Over-blocks repair work and zero-notional Torghut experiments.
- Treats an 18-hour-old fixed schedule runner parse error the same as a current controller failure.
- Creates incentives to delete evidence rather than classify it.

Decision: keep this as an emergency posture only.

### Option C: Terminal Evidence Half-Life Governor

Classify terminal evidence, give each class a half-life and carry budget, require a snapshot before retirement, and
wire the resulting carry into action gates.

Advantages:

- Lets serving and repair stay available while normal dispatch remains conservative.
- Turns retained failures into typed repair work instead of vague debris.
- Gives deployers precise cleanup and rollback gates.
- Gives Torghut a stronger input for capital carry decisions.

Disadvantages:

- Adds another collector and payload.
- Requires stable class names and half-life defaults.
- Needs careful rollout so advisory mode does not surprise operators.

Decision: select Option C.

## Architecture

Jangar emits:

```text
terminal_evidence_half_life
  schema_version
  ledger_id
  namespace
  generated_at
  fresh_until
  source_image
  observer_lease_refs
  terminal_classes
  debris_inventory
  retirement_candidates
  carry_budget
  data_carry
  action_class_gates
  rollback_target
```

Terminal classes:

- `failed_cronjob_wave`
- `failed_manual_attempt`
- `failed_agentrun`
- `old_image_running_job`
- `readiness_probe_burst`
- `stale_component_heartbeat`
- `persistent_snapshot_gap`
- `oversized_data_carry`
- `stale_profit_witness`

Each debris record includes object identity, namespace, kind, name, uid, owner reference, image digest when available,
phase, reason, first seen, last seen, half-life seconds, carry score, retirement snapshot state, and next action.

Carry budgets:

- `serve_readonly`: allowed with carry score below 100 if rollout and database are healthy.
- `dispatch_repair`: allowed when every high-carry class has a named repair target.
- `dispatch_normal`: held if failed schedule, failed AgentRun, stale heartbeat, or persistent snapshot carry is above 20.
- `deploy_widen`: held if readiness probe carry or old-image running job carry is above 10.
- `merge_ready`: held if any terminal class lacks a retirement snapshot.
- `torghut_capital_handoff`: held if stale profit witness or oversized data carry is above 0.

## Implementation Scope

Engineer stage:

- Add `services/jangar/src/server/control-plane-terminal-evidence.ts`.
- Read from Kubernetes through the existing gateway and from the app database through existing DB utilities.
- Compute terminal classes from Jobs, Pods, CronJobs, AgentRuns, component heartbeats, `resources_current`, and table
  stats.
- Add `terminal_evidence_half_life` to the control-plane status response.
- Add focused unit tests for class assignment, half-life decay, retirement eligibility, and action gate outputs.
- Keep enforcement advisory behind `JANGAR_TERMINAL_EVIDENCE_ENFORCEMENT=false` until deployer validation passes.

Deployer stage:

- Roll out collector in advisory mode.
- Capture at least three consecutive status samples across one schedule cycle.
- Retire old failed CronJob waves only after a durable snapshot exists.
- Enable enforcement for `merge_ready` and `dispatch_normal` first.
- Keep `serve_readonly` and `dispatch_repair` permissive unless live rollout becomes unhealthy.

Out of scope:

- Deleting Kubernetes objects in the architecture PR.
- Granting broad pod exec or secret access.
- Making Torghut live capital decisions directly in Jangar.

## Validation Gates

Required local checks:

- `bunx oxfmt --check docs/agents/designs/167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md docs/torghut/design-system/v6/171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md docs/jangar/application-architecture.md docs/torghut/design-system/v6/index.md`

Required engineer checks:

- Unit tests for half-life decay and class gates.
- A fixture with one old failed CronJob, one retry-succeeded AgentRun, one stale heartbeat, and one oversized table
  stat.
- A contract test proving `serve_readonly=allow`, `dispatch_repair=allow`, `dispatch_normal=hold`, and
  `merge_ready=hold` for the current evidence shape.

Required deployer checks:

- `kubectl get jobs,pods -n agents` before and after collector rollout.
- `curl /api/agents/control-plane/status?namespace=agents | jq '.terminal_evidence_half_life'`.
- Direct SQL sample for `pg_stat_user_tables` and `agents_control_plane.resources_current`.
- No cleanup until the ledger contains a retirement snapshot for the object class being retired.

## Rollout

1. Ship collector and payload in advisory mode.
2. Observe one full hourly schedule cycle.
3. Compare ledger carry against raw Kubernetes failed objects and SQL table stats.
4. Enable `merge_ready` and `dispatch_normal` enforcement.
5. Retire historical failed schedule debris through the deployer runbook once snapshots exist.
6. Feed `stale_profit_witness` and `oversized_data_carry` to the Torghut companion gate.

## Rollback

Rollback is data preserving:

- Set `JANGAR_TERMINAL_EVIDENCE_ENFORCEMENT=false`.
- Keep collection and status output enabled.
- Do not delete snapshots.
- Reopen `dispatch_normal` only if rollout health, database migrations, watch reliability, and current controller
  heartbeat remain healthy.
- Re-enable enforcement after the faulty class rule is patched and replayed against the saved snapshots.

## Risks

- Carry scores can become another opaque status field. The UI and API must show the object identities and next actions,
  not just a number.
- Advisory mode can be ignored. The rollout plan requires explicit enforcement for at least `merge_ready` and
  `dispatch_normal` after validation.
- Database table stats can lag reality. The collector must report stats freshness and avoid treating missing analyze
  timestamps as exact row truth.
- Over-retirement can erase useful forensic evidence. Retirement requires a snapshot and must preserve enough fields to
  reconstruct the failure class.

## Handoff Contract

Engineer acceptance:

- A status payload exists and is covered by tests.
- Current evidence shape produces a held `dispatch_normal` gate while keeping `serve_readonly` available.
- Retained failed Jobs and stale data carry appear as separate classes.
- The implementation does not add new logic to `supporting-primitives-controller.ts`.

Deployer acceptance:

- Advisory samples match raw `kubectl` and SQL evidence.
- Enforcement starts with `merge_ready` and `dispatch_normal`, not live capital.
- Cleanup is not performed until retirement snapshots exist.
- Rollback disables enforcement without deleting ledger state.
