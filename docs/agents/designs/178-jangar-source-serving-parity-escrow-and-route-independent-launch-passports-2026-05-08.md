# 178. Jangar Source-Serving Parity Escrow And Route-Independent Launch Passports (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, source-to-serving parity, schedule-runner launch safety, Torghut consumer
evidence, validation, rollout, rollback, and acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`

Extends:

- `177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`
- `176-jangar-resource-pressure-escrow-and-runner-qos-gates-2026-05-08.md`
- `175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`
- `docs/torghut/design-system/v6/181-torghut-quality-adjusted-profit-frontier-and-hypothesis-escrow-2026-05-08.md`

## Decision

I am selecting a **source-serving parity escrow with route-independent launch passports** as the next Jangar
control-plane architecture step.

The current cluster is not down. On 2026-05-08 around 04:20Z to 04:28Z, Jangar namespace pods were running,
`deployment/agents` was available `1/1`, and `deployment/agents-controllers` was available `2/2`. The Jangar control
plane status route answered from this workspace and reported database connectivity healthy with 28 registered Kysely
migrations and 28 applied migrations. It also reported watch reliability healthy with zero watch errors and zero
restarts in the 15-minute window.

The reliability gap is narrower and more dangerous. The `agents` namespace still had 84 failed pods, 9 running pods,
and 279 succeeded pods. Twenty-one Jobs were in `BackoffLimitExceeded`. The latest failed schedule-runner log showed
the runner failing before launch because it could not connect to
`http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` during the Jangar rollout.
Agents events in the same window showed controller readiness probe timeouts and earlier ephemeral-storage evictions.
The system is serving now, but launch admission still depends on a live route that is allowed to disappear during the
rollout it is supposed to protect.

The second gap is source-to-serving drift. The current source has `@app.get("/trading/consumer-evidence")` in
`services/torghut/app/main.py` at the merge head, and Jangar expects that route as its Torghut consumer-evidence
source. The live Torghut private revision `torghut-00297` was serving `/trading/status` and `/trading/autonomy`, but
both `http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` and the direct private service returned
HTTP 404. Jangar status consequently marked Torghut consumer evidence unavailable and held or blocked material action
classes. Source truth and serving truth are both valid evidence, but they disagree.

The selected design turns these two symptoms into one contract. Jangar will not require every launch-capable runner to
fetch the full status route at launch time. Instead, the supporting controller publishes a signed, bounded launch
passport snapshot into the schedule-runner ConfigMap and records it in a source-serving parity escrow. Runners verify
the embedded passport, then optionally refresh it from a bounded parity endpoint. A transient Jangar route refusal can
create `route_unavailable` evidence and hold normal dispatch, but it must not fan out into repeated CronJob failures
when a fresh, signed passport is already present. Downstream consumers, including Torghut, get a separate parity
decision that proves the endpoint they cite is actually live on the serving revision.

The tradeoff is stricter rollout promotion. A source PR that adds a route is not enough; the route has to be observed
on the live service before it can satisfy action or capital evidence. I accept that. The six-month failure mode is not
a single 404 or a single connection-refused error. It is a control plane that treats source intent, serving behavior,
and launch admission as interchangeable facts.

## Success Metrics

Success means:

- Jangar emits `source_serving_parity_escrow` in shadow mode beside the evidence-quality ledger and route-stability
  escrow.
- Each escrow entry records `source_ref`, `serving_ref`, `route_ref`, `route_method`, `expected_schema`,
  `source_present`, `serving_observed`, `serving_status_code`, `serving_revision`, `image_digest`,
  `parity_state`, `fresh_until`, `decision`, and `rollback_target`.
- The supporting controller publishes a `launch_passport_snapshot` into schedule runner ConfigMaps with passport,
  recovery warrant, proof cells, image digest, producer revision, and expiry.
- Schedule runners verify the embedded launch passport before they call the Kubernetes API and use the status route
  only as a refresh path when the embedded snapshot is stale or explicitly marked refresh-required.
- A Jangar status-route refusal during rollout produces typed parity evidence and material-action holds, not a broad
  wave of failed CronJob pods.
- Torghut consumer evidence cannot satisfy Jangar negative-evidence replacement unless `/trading/consumer-evidence`
  returns a current receipt from the live revision or an explicitly approved compatibility route.
- Bounded parity endpoints stay small enough for launch-time use and are validated separately from the full
  `/api/agents/control-plane/status` payload.
- Engineer and deployer handoffs define exact tests, cluster checks, rollout phases, and rollback levers.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, GitOps manifests,
trading flags, or AgentRun objects.

### Cluster And Rollout Evidence

- Local worktree was on `codex/swarm-jangar-control-plane-plan` at `44fd611a3`, matching `origin/main`, with no
  uncommitted changes before this design increment.
- `kubectl config current-context` was unset, but namespace-scoped reads worked as
  `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were all running, including `jangar-6ff949f885-4jmdk`, `jangar-db-1`, Redis, OpenWebUI,
  Bumba, and Symphony. The Jangar service endpoint pointed at `10.244.5.121:8080`.
- Agents deployments were available: `agents` `1/1`, `agents-alloy` `1/1`, and `agents-controllers` `2/2`.
- Agents pods grouped to 84 `Failed`, 9 `Running`, and 279 `Succeeded`.
- Failed pods included 8 Jangar discover, 9 Jangar implement, 10 Jangar plan, 11 Jangar verify, 8 Torghut quant
  discover, 8 Torghut quant implement, and 9 Torghut quant verify failures.
- Twenty-one Jobs were `BackoffLimitExceeded`.
- A recent Jangar plan schedule-runner failed while fetching Jangar control-plane status with `ConnectionRefused` for
  `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`.
- Agents warning events included readiness probe timeouts for both controller pods and the agents service, recent
  BackoffLimitExceeded events, earlier node affinity or taint scheduling pressure, and earlier ephemeral-storage
  eviction events.
- Torghut serving and sim pods were running, and the earlier sim ImagePullBackOff observed by the swarm had cleared.
  The active Torghut user container had restarted four times and last terminated with exit code 137.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` builds the schedule-runner command inline. The
  runner currently fetches the full Jangar status route with `fetch`, an `AbortController`, and a timeout before it
  creates AgentRuns or OrchestrationRuns.
- The same controller renders CronJobs with `concurrencyPolicy: Forbid`, one failed job history, and no independent
  route-failure dampener for admission status refresh failures.
- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts` treats a failed Torghut consumer-evidence
  route as `status=unavailable` and emits `torghut_consumer_evidence_unavailable`.
- `services/torghut/app/main.py` contains `@app.get("/trading/consumer-evidence")`, and
  `services/torghut/app/trading/consumer_evidence.py` builds a stable `torghut-consumer-evidence:*` receipt.
- The live Torghut service returned 404 for `/trading/consumer-evidence`, while `/trading/status` and
  `/trading/autonomy` were reachable. That is a source-to-serving parity failure, not a generic Torghut outage.
- `argocd/applications/torghut/knative-service.yaml` pinned live Torghut to image digest
  `sha256:a5f1bfde242b80a1c18d7776859dcb1b56d69c5ec5d742bb59b5244ec54c87a2`, so route parity must include both source
  ref and serving image digest.

### Database And Data Evidence

- Direct CNPG metadata and `pods/exec` were forbidden for this service account, so database evidence used app secrets
  and read-only SQL from the workspace.
- Jangar DB identity was database `jangar`, user `jangar`, observed at `2026-05-08T04:25:18.994Z`.
- Jangar schema had 99 base tables across `agents_control_plane`, `atlas`, `codex_judge`, `jangar_github`,
  `memories`, `public`, `terminals`, `torghut_control_plane`, and `workflow_comms`.
- Jangar migration table had 28 rows, latest migration
  `20260505_torghut_quant_pipeline_health_window_index`; the status API also reported 28 registered and 28 applied.
- Current Jangar data was live: `public.agent_runs` had 630 rows updated at `2026-05-08T04:26:56Z`,
  `workflow_comms.agent_messages` had 14,679 rows updated at `2026-05-08T04:26:16Z`, and
  `public.torghut_market_context_runs` had 76 rows updated at `2026-05-08T04:25:38Z`.
- Torghut DB identity was database `torghut`, user `torghut_app`, observed at `2026-05-08T04:25:18.991Z`.
- Torghut schema had 69 public tables and Alembic version `0029_whitepaper_embedding_dimension_4096`.
- Torghut data was mixed: `execution_tca_metrics` had 13,775 rows updated at `2026-05-08T02:38:30Z`,
  `position_snapshots` had 43,757 rows updated at `2026-05-07T20:58:04Z`, `trade_decisions` had 147,623 rows last
  created on `2026-05-06T17:44:19Z`, and `vnext_empirical_job_runs` had 24 rows updated at
  `2026-05-07T21:27:18Z`.
- ClickHouse pods were running, but direct HTTP query returned 401 without credentials, so ClickHouse row-level
  assessment was not available in this observer context.

## Problem

Jangar currently has two truth surfaces that can diverge during the exact windows where automation most needs clear
truth.

1. Schedule runners depend on a live Jangar status route at launch time, even though the supporting controller already
   had enough admission information to stamp the schedule.
2. A transient route refusal becomes a failed pod and can fan out under CronJob retries.
3. Full status is too broad for launch admission and can be slower or less available than a bounded launch-passport
   projection.
4. Source can contain a required downstream route while the live serving revision still returns 404.
5. Jangar currently has no single parity receipt that says "this source contract is live on this image digest".
6. Torghut capital and evidence decisions can be blocked by a missing route, but the repair signal is too generic to
   distinguish route absence, stale receipt, bad schema, or capital-quality failure.

The control plane needs launch admission and route parity to be durable artifacts, not incidental HTTP side effects.

## Alternatives Considered

### Option A: Add Retries Around Schedule-Runner Status Fetches

Retry `fetch(status)` with exponential backoff before failing the schedule runner.

Advantages:

- Smallest code change.
- Reduces some connection-refused failures.
- Leaves current status route contract intact.

Disadvantages:

- Still couples launch admission to a live monolithic route.
- Adds more pods sitting in retry loops during rollout turbulence.
- Does not solve source-to-serving drift for Torghut consumer evidence.

Decision: reject as the primary architecture. Retries are useful, but they do not create a durable authority surface.

### Option B: Freeze All Schedules During Jangar And Torghut Rollouts

Hold every launch-capable schedule while either Jangar or Torghut is rolling or route parity is uncertain.

Advantages:

- Strong safety boundary.
- Easy for deployers to reason about.
- Prevents fanout during known rollout windows.

Disadvantages:

- Turns a local route issue into a global throughput freeze.
- Delays observe-only and repair work that could clear the problem.
- Still requires a separate mechanism to prove the route is live after rollout.

Decision: keep as an emergency lever, not as the default system behavior.

### Option C: Source-Serving Parity Escrow And Route-Independent Launch Passports

Publish a signed launch-passport snapshot with each schedule, verify it locally in the runner, and maintain a separate
parity escrow that proves source routes are live on serving revisions before they satisfy action or capital evidence.

Advantages:

- Decouples launch safety from full status route availability.
- Converts source/serving drift into typed repair evidence.
- Preserves serve-readonly and observe-only work while holding normal dispatch and capital.
- Gives Torghut one route-proven receipt contract instead of generic unavailable status.

Disadvantages:

- Adds a bounded snapshot format and signing/expiry lifecycle.
- Requires careful invalidation when the runtime kit, image digest, or recovery warrant changes.
- May hold promotions that previously relied on source-only proof.

Decision: select Option C.

## Architecture

Jangar adds two connected projections.

```text
launch_passport_snapshot
  snapshot_id
  generated_at
  fresh_until
  namespace
  schedule_ref
  swarm_name
  stage
  image_digest
  producer_revision
  admission_passport
  recovery_warrant
  runtime_proof_cells
  required_runtime_kits
  signature
  refresh_policy
  rollback_target
```

```text
source_serving_parity_escrow
  escrow_id
  generated_at
  fresh_until
  source_ref
  source_commit
  serving_ref
  serving_revision
  image_digest
  route_ref
  route_method
  expected_schema
  observed_schema
  source_present
  serving_observed
  serving_status_code
  parity_state             # converged | source_ahead | serving_ahead | route_missing | schema_mismatch | unknown
  decision                 # allow | observe_only | repair_only | hold | block
  action_classes
  reasons
  rollback_target
```

The runner flow changes:

1. Supporting controller resolves admission and proof surfaces during schedule reconciliation.
2. Controller writes `run.json` and `launch-passport.json` into the schedule ConfigMap.
3. Runner verifies snapshot signature, expiry, image digest, stage, and required proof cells.
4. Runner refreshes from `GET /api/agents/control-plane/launch-passport?namespace=...&schedule=...` only when the
   snapshot is stale or refresh policy requires a live check.
5. If refresh fails but the embedded snapshot is fresh and the route parity escrow is not blocking, runner launches
   with `launch_passport_source=embedded`.
6. If the embedded snapshot is stale or contradicted, runner exits with a typed `LaunchPassportStale` or
   `LaunchPassportContradicted` reason and the schedule backpressure layer suppresses duplicate CronJob fanout.

The parity flow is separate:

1. Jangar records source route inventory from the repo and expected routes from configured consumers.
2. Deployer or controller probes live serving routes with bounded requests.
3. Parity escrow entries feed material action receipts and the evidence-quality ledger.
4. Torghut consumer evidence is action-grade only when source and serving both prove the route and schema.

## Implementation Scope

Engineer stage should implement:

- A pure launch-passport builder and verifier under `services/jangar/src/server`.
- Supporting-controller render changes that write a bounded `launch-passport.json` and pass its path to the runner.
- Runner logic that prefers the embedded passport and records typed refresh failures.
- A bounded `launch-passport` status route that returns only the current schedule passport, not the full control-plane
  status payload.
- A source-serving parity reducer and status projection with tests for source-ahead, serving route missing, schema
  mismatch, and converged states.
- Torghut consumer-evidence parity checks that distinguish HTTP 404, stale receipt, missing receipt, and schema
  mismatch.

Deployer stage should implement:

- Rollout verification that probes `/api/agents/control-plane/launch-passport` and configured downstream consumer
  routes after image promotion.
- A post-deploy gate that refuses deploy widening when a source-required route returns 404 on the serving revision.
- Observability for launch-passport source counts: embedded, refreshed, stale, contradicted, refresh_failed.

## Validation Gates

Local validation:

- `bun --cwd services/jangar run test -- supporting-primitives-controller`
- `bun --cwd services/jangar run test -- control-plane`
- `bun --cwd services/jangar run tsc`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k consumer_evidence`

Cluster validation:

- `kubectl get pods -n agents -o json` shows no new fanout of failed schedule-runner pods after a Jangar rollout.
- Logs from the selected schedule-runner pod in `agents` show `launch_passport_source=embedded` or
  `launch_passport_source=refreshed`, not raw full-status route dependency.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/launch-passport?namespace=agents` returns a
  bounded object under 64 KiB.
- `curl http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` returns HTTP 200 with
  `torghut_consumer_evidence_receipt.receipt_id`, or Jangar parity escrow reports `route_missing` with a repair-only
  decision.

Data validation:

- Jangar migration consistency stays `registered_count == applied_count`.
- Launch passport snapshots cite the same image digest and producer revision as the serving status payload.
- Parity escrow entries include both source commit and serving image digest.

## Rollout

1. Ship launch-passport builder, verifier, and parity reducer in shadow mode.
2. Render embedded launch passports into schedule ConfigMaps, but keep the existing full-status refresh as primary.
3. Flip schedule runners to prefer embedded passports for fresh snapshots while still recording refresh results.
4. Make full-status route failures typed degradation evidence instead of immediate runner failure when the embedded
   snapshot is fresh.
5. Enable source-serving parity as a material action input for deploy widening and Torghut consumer evidence.
6. Require parity convergence for normal dispatch and capital-facing actions.

## Rollback

- Set `JANGAR_SCHEDULE_RUNNER_EMBEDDED_PASSPORT_ENABLED=false` to return to live status refresh.
- Set `JANGAR_SOURCE_SERVING_PARITY_ENFORCEMENT=shadow` to remove parity from material action decisions.
- Keep `serve_readonly` and `torghut_observe` allowed when parity is missing but the Jangar service and database are
  healthy.
- If the parity reducer emits false blocks, use the last known route-stability escrow and evidence-quality ledger as
  the temporary authority while the reducer is fixed.

## Risks

- Signing mistakes can block all schedules. Mitigation: shadow mode first, deterministic verifier tests, and explicit
  rollback env var.
- Embedded passports can become stale. Mitigation: short `fresh_until`, image digest checks, and refresh-required
  policy on rollout boundaries.
- Route probes can become noisy. Mitigation: bounded route inventory, per-route TTLs, and action-class-specific
  decisions.
- Torghut may expose receipt shape changes. Mitigation: schema version on the receipt and parity decisions that
  distinguish route presence from schema compatibility.

## Handoff

Engineer acceptance gate: demonstrate that a simulated Jangar status-route connection refusal does not fail a runner
when a fresh embedded passport is present, and that stale or contradicted passports still fail closed.

Deployer acceptance gate: do not widen Jangar, Agents, or Torghut rollouts from source-only evidence. Widen only when
the parity escrow shows required routes live on the serving revision and launch-passport refresh can be probed.

Torghut acceptance gate: keep paper and live capital at zero notional until the consumer-evidence route returns a
current route-proven receipt or Jangar explicitly marks the route as compatibility-approved.
