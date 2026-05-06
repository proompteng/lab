# 101. Jangar Evidence Provenance Firewall And Lease Graduation Contract (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane evidence provenance, failure-domain lease correctness, dispatch admission, rollout
holdbacks, merge-ready claims, and Torghut capital consumers.

Companion Torghut contract:

- `docs/torghut/design-system/v6/105-torghut-proof-provenance-firewall-and-profit-lease-graduation-2026-05-06.md`

Extends:

- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`
- `99-jangar-evidence-lease-cells-and-rollout-admission-arbiter-2026-05-06.md`
- `75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`

## Decision

I am choosing an **evidence provenance firewall** as the next Jangar control-plane architecture step.

The latest cluster and database state is better than yesterday's degraded execution-trust picture. Argo reports
`agents`, `agents-ci`, `jangar`, `symphony-jangar`, `symphony-torghut`, `torghut`, and `torghut-options` as `Synced`
and `Healthy`. Jangar, Agents, and Agents Controllers Deployments are available. The status endpoint reports healthy
rollout health, healthy watch reliability, healthy execution trust, a connected database, and 28 registered/applied
Kysely migrations.

The same status endpoint still held `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital` on
`source_schema.database_unroutable`. The source pass found why: the database lease classifier accepted any pod name
containing `db` as database evidence. An Agents runner pod with a random suffix containing `db` could therefore become
database-negative evidence even though the app database probe and migration table were healthy.

That is a provenance failure, not a database outage. The selected architecture makes evidence source identity part of
lease admission. A lease cannot affect an action class unless its producer, namespace, resource kind, and classifier
all match the declared evidence class. The tradeoff is stricter evidence plumbing and a few more tests around
classifier boundaries. I accept that because action-class safety depends on not letting coincidental names become
control-plane authority.

## Read-Only Evidence Snapshot

All cluster and database checks were read-only. No Kubernetes resources or database rows were mutated.

### Runtime Inputs

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/swarm-jangar-control-plane-discover`
- Runtime identity: `system:serviceaccount:agents:agents-sa`
- Runtime date: `2026-05-06`

### Cluster And Rollout Evidence

- `kubectl get pods -n jangar -o wide` showed `jangar-d75944dff-4msq2` at `2/2 Running`, `jangar-db-1` at
  `1/1 Running`, and the Bumba, Alloy, Redis, Open WebUI, Symphony, and Symphony Jangar pods running.
- `kubectl get deploy -n jangar` showed `jangar`, `bumba`, `jangar-alloy`, `symphony`, and `symphony-jangar`
  available at desired replicas.
- Jangar events showed the current `0bba2aa8` image rollout succeeded after one transient readiness refusal during
  startup.
- `kubectl get pods -n agents --no-headers` counted `Completed=92`, `Error=30`, and `Running=6`; jobs counted
  `Complete=96`, `Failed=26`, and `Running=2`.
- Current hourly swarm CronJobs were creating and completing jobs, while retained failed plan/verify pods remained
  visible as historical debt.
- `kubectl get applications -n argocd ...` reported the Jangar, Agents, Symphony, and Torghut applications as
  `Synced` and `Healthy`.
- RBAC allowed named status and secret reads but denied broad `statefulsets`, `knative services`, CNPG cluster reads,
  and pod exec. Deployer gates must therefore rely on projected evidence, not privileged debug paths.

### Status Evidence

- `GET /api/agents/control-plane/status?namespace=agents` reported:
  - database `configured=true`, `connected=true`, `status=healthy`, latency 3 ms;
  - migration consistency healthy with 28 registered and 28 applied migrations;
  - watch reliability healthy over 15 minutes, 8,627 AgentRun events, zero errors;
  - execution trust healthy with no blocking windows;
  - rollout health healthy for `agents` and `agents-controllers`;
  - failure-domain leases in shadow mode allowing `serve_readonly`, `dispatch_repair`, and `torghut_observe`;
  - shadow holds for `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital` on
    `source_schema.database_unroutable`.
- Agents logs still showed repeated OTLP metric export failures to
  `observability-mimir-nginx.observability.svc.cluster.local`.
- Jangar logs still showed GitHub review-ingest ref misses for several swarm and promotion branches.

### Source Evidence

- `services/jangar/src/server/control-plane-failure-domain-leases.ts` builds database and source-schema leases that
  feed action-class holdbacks.
- Before this change, `isDatabasePod` used `name.includes('db')`, so arbitrary runner suffixes could poison database
  evidence.
- This PR narrows the classifier to database-name tokens (`db`, `database`, `postgres`, `postgresql`) or explicit
  database/CNPG labels. A runner pod such as
  `jangar-control-plane-plan-sched-zczg7-step-1-attempt-1-4dbnk` no longer counts as database evidence.
- The regression test asserts that a failed runner pod with `db` in a suffix leaves the database and source-schema
  leases valid when the database probe and migrations are healthy.

### Database And Data Evidence

- Jangar SQL connected as `jangar` to database `jangar` at `2026-05-06T04:12:16Z`; table count was 99.
- `kysely_migration` had 28 applied migrations; latest was `20260505_torghut_quant_pipeline_health_window_index`.
- `agents_control_plane.resources_current` had 3,354 rows, 129 active rows, and newest resource update at
  `2026-05-06T04:12:16.947Z`.
- `resources_current` included 3,155 failed `AgentRun` rows, 125 succeeded, 23 running, and 12 templates.
- `agents_control_plane.component_heartbeats` had fresh healthy heartbeats for `agents-controller`,
  `orchestration-controller`, `supporting-controller`, and `workflow-runtime`, expiring at `2026-05-06T04:14:04Z`.
- `public.agent_runs` counted 141 failed, 123 succeeded, and 26 running rows.
- `torghut_control_plane.simulation_runs` in Jangar was stale: newest failed evidence was March 19 and newest
  succeeded/running/submitted evidence was March 13-14.

## Problem

Jangar has enough status surfaces to protect itself, but a status surface can still be wrong if the evidence is
misclassified. The current failure mode is specific:

1. A healthy application database probe can conflict with an invalid database lease.
2. A random pod suffix can masquerade as database evidence.
3. Action-class holdbacks amplify the false negative into dispatch, rollout, merge, and Torghut capital decisions.
4. Least-privilege deployers cannot safely override this by execing into database pods.
5. Torghut consumers need compact Jangar decisions, but compact decisions are only useful if evidence provenance is
   strict.

## Alternatives Considered

### Option A: Trust The Database Probe Over Kubernetes Evidence

Pros:

- Fast.
- Removes the immediate false hold.
- Keeps the source-schema lease simple.

Cons:

- Ignores real pod-level database rollout failures.
- Recreates a route-only authority pattern.
- Does not fix the classifier that caused the false evidence.

Decision: reject.

### Option B: Disable Database Pod Evidence In Shadow Leases

Pros:

- Avoids false database pod matches.
- Keeps action-class gates quiet while the lease model matures.

Cons:

- Throws away useful CNPG disruption and readiness evidence.
- Makes deploy widening less safe during database rollouts.
- Hides the provenance problem instead of solving it.

Decision: reject except as an emergency rollback.

### Option C: Evidence Provenance Firewall

Pros:

- Keeps database pod evidence, but only from source-qualified resources.
- Protects action-class holdbacks from coincidental names and stale sources.
- Gives engineers a regression-testable boundary.
- Gives deployers one clear acceptance gate: provenance-clean leases before enforcement.

Cons:

- Requires stricter classifier tests.
- May initially reject some unlabeled database-like pods until their labels are fixed.

Decision: select Option C.

## Architecture

Every material lease producer must declare and enforce an evidence provenance contract:

```text
evidence_provenance
  evidence_class          # database, route, rollout, registry, storage, workflow_artifact, nats, source_schema
  producer                # status_projector, controller, verifier_job, deployer
  namespace
  resource_kind
  resource_name
  classifier_version
  accepted_reason
  rejected_reason
  observed_at
```

Database pod evidence is accepted only when one of these is true:

- `cnpg.io/cluster` is present;
- `app.kubernetes.io/component` contains `database`;
- `app.kubernetes.io/name` contains `postgres` or `database`;
- the pod name contains a database token bounded by `-`, `_`, `.`, start, or end.

Database pod evidence is rejected when `db` appears only inside an unrelated token or generated suffix.

## Validation Gates

- Unit: a failed runner pod with a `db` suffix must not expire database or source-schema leases.
- Unit: a terminating CNPG pod with `DisruptionTarget=True` must still expire database leases.
- Status: healthy database plus healthy migrations must produce a valid `source_schema` lease unless qualified
  database evidence says otherwise.
- Deployer: before enforcing failure-domain leases, `dispatch_normal`, `deploy_widen`, `merge_ready`, and
  `torghut_capital` holds must cite source-qualified evidence refs.

## Rollout

1. Ship the classifier fix and regression test.
2. Keep failure-domain leases in shadow mode for at least two projection windows.
3. Confirm the current false `source_schema.database_unroutable` hold disappears when no source-qualified database
   evidence is negative.
4. Only then consider enforcing the reconciliation clock for `dispatch_normal` or `merge_ready`.

## Rollback

- Revert the classifier change if real CNPG or Postgres pods stop producing database leases.
- If a rollback is needed before code revert, keep lease enforcement in shadow mode and gate deploy widening manually
  on database probe plus Argo rollout health.

## Risks

- An unlabeled database pod with an unusual name could be ignored until labels are corrected.
- Historical false holds may remain in logs or durable status snapshots until refreshed.
- Metrics export and Git ref ingestion failures remain separate evidence-quality issues; this contract prevents them
  from being misclassified but does not repair them.

## Handoff

Engineer:

- Keep the classifier small and explicit.
- Add provenance tests for every new lease domain before enforcement.
- Do not widen name heuristics without a failing test from real cluster evidence.

Deployer:

- Validate through `/api/agents/control-plane/status?namespace=agents`.
- Accept rollout only when database/source-schema holds cite source-qualified evidence or disappear.
- Roll back to shadow-only enforcement if provenance-clean leases cannot be produced.
