# 100. Jangar Lease Reconciliation Clock And Dispatch Expiry Contract (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, conflicting evidence reconciliation, dispatch admission, merge-ready claims,
Torghut capital holdbacks, and least-privilege deployment validation.

Companion Torghut contract:

- `docs/torghut/design-system/v6/104-torghut-proof-expiry-clock-and-hypothesis-rehydration-lanes-2026-05-06.md`

Extends:

- `99-jangar-evidence-lease-cells-and-rollout-admission-arbiter-2026-05-06.md`
- `98-jangar-action-slo-budget-and-profit-proof-exchange-2026-05-06.md`
- `94-jangar-proof-backed-rollout-brake-and-repair-debt-ledger-2026-05-05.md`
- `75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`

## Decision

I am choosing a **lease reconciliation clock** as the next Jangar control-plane architecture step.

The latest read-only evidence is not a broad outage. `kubectl rollout status` reports `deploy/agents`,
`deploy/agents-controllers`, and `deploy/jangar` successfully rolled out. Jangar status at
`2026-05-06T03:23:44.130Z` reports a connected database, 28 registered and 28 applied Kysely migrations, healthy
rollout health, healthy watch reliability, and no recent failed jobs in the 15 minute workflow window.

The risk is that the same status payload also emits shadow failure-domain holdbacks for `dispatch_normal`,
`deploy_widen`, `merge_ready`, and `torghut_capital` because `source_schema.database_unroutable` is still present.
That contradiction matters more than either side alone. If the app database check is healthy but the lease projector
says source schema is not routable, Jangar needs a deterministic way to decide whether a material action is allowed,
held for observation, or restricted to repair.

The selected design makes the reconciliation clock the authority over lease conflicts. It does not replace the existing
failure-domain leases. It consumes them, assigns a conflict class and expiry, and produces one compact action decision
per namespace/action class. The tradeoff is stricter admission: some green-looking rollouts will still be held until
their contradictory negative evidence expires or is retired. I accept that. The failure mode I want to remove is a
quietly stale or internally inconsistent safety signal being treated as permission to widen rollout, dispatch normal
work, or tell Torghut that capital-adjacent proof is ready.

## Read-Only Evidence Snapshot

All cluster and database checks were read-only. No Kubernetes resources or database rows were mutated.

### Runtime Inputs

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/swarm-jangar-control-plane-plan`
- Swarm: `jangar-control-plane`
- Stage: `plan`
- Runtime identity: `system:serviceaccount:agents:agents-sa`
- Runtime date: `2026-05-06`
- Progress issue: `#5612`

### Cluster And Rollout Evidence

- `kubectl config current-context` returned `current-context is not set`, while `kubectl auth whoami` resolved to
  `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed the serving pod `jangar-d75944dff-4msq2` at `2/2 Running` and
  `jangar-db-1` at `1/1 Running`.
- `kubectl rollout status deploy/jangar -n jangar` returned `deployment "jangar" successfully rolled out`.
- `kubectl get deploy -n agents -o wide` showed `agents` at `1/1`, `agents-alloy` at `1/1`, and
  `agents-controllers` at `2/2`.
- `kubectl rollout status deploy/agents -n agents` and
  `kubectl rollout status deploy/agents-controllers -n agents` both returned successfully rolled out.
- `kubectl get pods -n agents --no-headers | awk ...` counted `Running 5`, `Completed 86`, `Error 30`, and one
  transient `ContainerCreating` pod while this plan run was active.
- `kubectl get jobs -n agents --no-headers | awk ...` counted 90 completed jobs and 28 failed jobs.
- Recent Agents events show the current hourly swarm CronJobs creating and completing jobs, but also preserve the
  previous readiness failures on `agents-controllers-b69df966c-*` and `agents-f8c5789b9-wrz7l` before the 0bba2aa8
  rollout replaced them.
- `kubectl get pods -n torghut -o wide` showed the live revision `torghut-00228` and simulation revision
  `torghut-sim-00309` both at `2/2 Running`.
- RBAC prevented direct reads of Knative services, FlinkDeployments, PodDisruptionBudgets, secrets, and CNPG pod exec
  from this service account. Those access denials are part of the evidence: deployer validation must be possible
  through approved projected status and service endpoints, not privileged introspection.

### Jangar Status Evidence

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` generated a status
  payload at `2026-05-06T03:23:44.130Z`.
- Database status was healthy: configured, connected, 3 ms latency, `kysely_migration`, 28 registered migrations, 28
  applied migrations, no unapplied migrations, no unexpected migrations, latest registered/applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy across two deployments: `agents` and `agents-controllers`.
- Watch reliability was healthy over 15 minutes, with 8,667 `agentruns.agents.proompteng.ai` events, zero errors, and
  zero restarts.
- Workflow reliability was healthy over 15 minutes: zero active job runs, zero recent failed jobs, zero
  backoff-limit-exceeded jobs, and high confidence.
- Dependency quorum was blocked on `empirical_jobs_degraded`.
- Empirical services were not authoritative: forecast `registry_empty`, Lean `disabled`, and jobs degraded with stale
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Failure-domain holdbacks were internally important: `serve_readonly` and `dispatch_repair` were allowed, while
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital` were held on
  `source_schema.database_unroutable`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already composes database status, rollout health, workflow
  reliability, watch reliability, runtime admission, failure-domain leases, execution trust, and empirical services.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` already classifies action classes such as
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital`.
- `services/jangar/src/server/supporting-primitives-controller.ts` enforces schedule launch admission before creating
  CronJob runner resources and marks schedules `AdmissionBlocked` when a stage passport is missing or blocked.
- The same controller owns workspace PVC lifecycle and reads `persistentvolumeclaim` status to move workspaces between
  `Pending`, `Ready`, `Failed`, and `Expired`.
- `services/jangar/src/server/primitives-kube.ts` now has first-class aliases for `persistentvolumeclaim`,
  `persistentvolumeclaims`, `pvc`, and `pvcs`.
- The high-risk gap is no longer "can Jangar see these surfaces?" The gap is "which surface wins when the surfaces
  disagree, and when does the losing evidence expire?"

### Database And Data Evidence

- Direct database exec and secret listing were forbidden from this pod, so this assessment uses application-projected
  database status plus service readiness payloads.
- Jangar database schema consistency is healthy from the application path, but the failure-domain projector still emits
  `source_schema.database_unroutable`. That is a data-quality conflict, not a hard DB outage.
- Torghut live `/readyz` returned HTTP 503 with healthy Postgres and ClickHouse checks, current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, migration parent-fork warnings, universe source `jangar` with
  `symbols_count=0`, live submission blocked on `simple_submit_disabled`, and zero promotion eligibility.
- Torghut simulation `/readyz` returned HTTP 200 with the same schema head, `promotion_eligible_total=0`,
  `rollback_required_total=3`, and degraded quant evidence because the Jangar latest metrics store is empty.

## Problem

Jangar has crossed the point where a single green/red health bit is useful. The current control plane can show:

1. A healthy database check and an expired or unknown database/source-schema lease at the same time.
2. A healthy rollout and retained failed pods/jobs from earlier attempts.
3. Healthy watch streams and stale empirical proof from a downstream consumer.
4. Repair actions that should remain open while normal dispatch, rollout widening, merge-ready claims, and Torghut
   capital actions should stay held.
5. Least-privilege validation needs from deployers who cannot use pod exec, secret reads, or broad CRD reads.

Without a reconciliation clock, the system either over-blocks everything or over-trusts the newest positive signal.
Both are wrong. Jangar needs an action-scoped, expiry-aware reducer that can explain why a material action is allowed
or held using the same semantics for engineers, deployers, and Torghut consumers.

## Alternatives Considered

### Option A: Trust The Latest Positive Status

This option treats the healthy database, rollout, watch, and workflow checks as sufficient. Failed historical pods and
shadow holdbacks are treated as informational.

Pros:

- Minimal implementation.
- Keeps hourly swarm dispatch moving.
- Avoids adding another status object.

Cons:

- Recreates the unsafe failure mode: green serving health can over-authorize material actions.
- Ignores the existing failure-domain lease model.
- Gives Torghut a capital signal that can be newer but weaker than the negative evidence.

Decision: reject.

### Option B: Keep The Existing Shadow Holdbacks And Do Nothing Else

This option preserves the current failure-domain leases and asks humans to interpret contradictions.

Pros:

- Low code churn.
- The existing status payload already exposes the holdbacks.
- Deployer can manually gate rollout widening.

Cons:

- Manual interpretation does not scale across swarm cadence.
- It leaves no machine-readable explanation for why healthy DB status and database-unroutable source schema disagree.
- It does not define expiry, conflict priority, or acceptance gates for engineer/deployer stages.

Decision: reject as the target architecture, but keep the current leases as inputs.

### Option C: Lease Reconciliation Clock

This option adds a reducer over current leases, status checks, and consumer evidence. It emits one decision per
action class, with conflict class, fresh-until, owner, evidence refs, and rollback target.

Pros:

- Makes contradictions first-class.
- Keeps `dispatch_repair` and read-only serving open while holding unsafe material actions.
- Lets deployers validate safety through one projected endpoint.
- Lets Torghut consume a compact Jangar decision instead of inferring from broad route health.
- Aligns with the existing action class model.

Cons:

- Adds a new projection and tests.
- Needs a shadow period to tune false holds.
- Requires event dedupe so retained failed jobs do not permanently poison the clock.

Decision: select Option C.

## Chosen Architecture

### ReconciledActionClock

Jangar should project a current record per namespace and action class:

```text
reconciled_action_clock
  namespace
  action_class              # serve_readonly, dispatch_repair, dispatch_normal, deploy_widen,
                            # merge_ready, torghut_observe, torghut_capital
  decision                  # allow, observe_only, repair_only, hold, block
  conflict_class            # none, stale_negative, contradictory_positive_negative, missing_authority, consumer_debt
  confidence                # high, medium, low
  observed_at
  fresh_until
  positive_lease_ids[]
  negative_lease_ids[]
  blocking_reason_codes[]
  required_repair_actions[]
  rollback_target
  producer_revision
```

The reducer rules are deliberately boring:

- `serve_readonly` can allow on route health alone unless auth or data-corruption evidence blocks it.
- `dispatch_repair` can allow with storage and collaboration leases even when normal dispatch is held.
- `dispatch_normal` needs route, rollout, storage, workflow artifact, source schema, and collaboration leases.
- `deploy_widen` needs route, rollout, registry, source schema, and no unresolved current controller readiness failures.
- `merge_ready` needs database/source-schema agreement and no unresolved validation failure for the PR branch.
- `torghut_capital` needs Jangar route/rollout/source-schema agreement plus a Torghut proof-expiry decision.

### Conflict Resolution

When positive and negative evidence disagree, the clock chooses the safer action-scoped state and names the conflict.
For the current evidence:

- Jangar DB check healthy + source-schema lease held -> `conflict_class=contradictory_positive_negative`.
- Latest 15 minute workflow clean + retained failed jobs -> allow `dispatch_repair`, hold only if a current stage window
  fails or the same failure repeats within the configured window.
- Torghut route reachable + empirical jobs stale -> allow `torghut_observe`, hold `torghut_capital`.

### Expiry Rules

- Positive rollout/watch/database checks expire in 60 seconds unless refreshed.
- Negative lease evidence expires only after the source stops reporting the condition for two consecutive projection
  windows, not just after a wall-clock timeout.
- Historical failed jobs age out of normal dispatch only when they are older than the configured workflow window and
  not repeated by the same stage/head pair.
- Consumer proof debt from Torghut expires only when Torghut publishes a fresh proof-expiry clock with non-stale
  empirical jobs and non-empty latest quant metrics.

## Engineer Handoff

Implement the reconciliation clock in three narrow slices:

1. Add a pure reducer under `services/jangar/src/server/` that accepts the existing `FailureDomainLeaseSet`,
   `DatabaseStatus`, `ControlPlaneRolloutHealth`, `WorkflowsReliabilityStatus`, watch reliability, and empirical
   service payloads and returns `ReconciledActionClock[]`.
2. Add unit tests for the current conflict: database status healthy, source-schema/database lease held, repair allowed,
   normal dispatch/deploy/merge/capital held.
3. Add the clocks to `/api/agents/control-plane/status` without enforcing them in schedule creation for the first
   release. Enforcement can follow after one release cycle of shadow evidence.

Acceptance gates:

- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-action-clock.test.ts` from
  `services/jangar`.
- `bunx oxfmt --check` on every changed TypeScript file.
- A status payload in-cluster showing `serve_readonly=allow`, `dispatch_repair=allow`, and the material actions held
  with `source_schema.database_unroutable` until that conflict is retired.

## Deployer Handoff

Roll out in shadow mode first.

1. Deploy the status projection only.
2. Confirm the status route emits clocks for `agents`.
3. Confirm no CronJob admission behavior changes in the first rollout.
4. After one clean release cycle, enable enforcement only for `merge_ready` and `torghut_capital`.
5. Enable `dispatch_normal` enforcement only after retained failed jobs stop producing false holds.

Rollback:

- Revert the status projection commit or set the feature flag to hide/enforce nothing.
- Keep serving and `dispatch_repair` open unless route/auth/database checks are actually failed.
- Do not delete retained failed pods as a substitute for retiring the evidence through the clock.

## Risks

- The first reducer may be too conservative if retained failed jobs are not deduped by stage/head/time window.
- The database/source-schema contradiction may be a projector bug rather than a database outage; the design requires
  fixing the projector or explicitly documenting the evidence path before enforcement.
- RBAC limits mean deployers need projected evidence to be correct. If the projection is wrong, least-privilege users
  have no fallback except owner escalation.
- Torghut capital gating depends on the companion proof-expiry clock landing with compatible semantics.

## Open Questions

- Should `merge_ready` be held by any unresolved source-ref miss, or only by misses on the active PR head?
- Should the first enforcement target be `torghut_capital` only, leaving `merge_ready` as advisory for one more cycle?
- Which retention window should separate useful historical failed-job evidence from old pod noise: 15 minutes, one
  swarm cadence, or one release cycle?
