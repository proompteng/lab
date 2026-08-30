# 102. Jangar Dual-Authority Dispatch Ledger And Capital Proof Firewall (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, rollout-derived authority, controller heartbeat authority, runtime admission,
workflow dispatch, capital-adjacent Torghut proof consumption, and safer rollout behavior.

Companion Torghut contract:

- `docs/torghut/design-system/v6/106-torghut-live-proof-recovery-ledger-and-options-data-firewall-2026-05-06.md`

Extends:

- `101-jangar-account-scoped-proof-liquidity-and-query-budget-2026-05-06.md`
- `101-jangar-evidence-provenance-firewall-and-lease-graduation-contract-2026-05-06.md`
- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`
- `99-jangar-evidence-lease-cells-and-rollout-admission-arbiter-2026-05-06.md`

## Decision

I am choosing a **dual-authority dispatch ledger with a capital proof firewall** for Jangar.

The control plane has recovered enough to serve and schedule. Argo reports `agents`, `agents-ci`, `jangar`,
`symphony-jangar`, `symphony-torghut`, `torghut`, and `torghut-options` as `Healthy` and `Synced`. The `agents` app is
available, `agents-controllers` is `2/2`, and Jangar's status route reports workflow and job runtimes configured. That
is material progress from the earlier soak, where runtime trust was degraded and one controller replica was not ready.

The recovered state is still not a clean authority model. Jangar is deriving some controller and runtime authority from
the available `agents-controllers` rollout while `agents_control_plane.component_heartbeats` in the Jangar database
shows disabled heartbeat rows from the Jangar app pod for `agents-controller`, `supporting-controller`, and
`workflow-runtime`. The system is not wrong to use rollout-derived readiness as a fallback, but it is wrong to let that
fallback silently equal heartbeat truth for normal dispatch, merge-readiness claims, or Torghut capital decisions.

The chosen architecture records both authority sources in one append-only dispatch ledger. Rollout authority can keep
repair and observation open. Heartbeat authority is required for widening normal dispatch, claiming mergeable workflow
readiness, or providing a capital-proof decision to Torghut. The capital proof firewall then exposes only the reduced,
action-class-specific decision to Torghut. Torghut does not have to interpret Jangar rollout health, disabled local
heartbeats, stale simulation rows, or failed AgentRun debt directly.

The tradeoff is deliberate friction. Some work that used to run on "Deployment healthy" will wait for a heartbeat or an
explicit repair lane. I accept that because the failure mode to remove is over-authorization after partial recovery.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, or runtime records were mutated during this assessment.

### Cluster And Rollout Evidence

- `kubectl auth whoami` identified the runtime as `system:serviceaccount:agents:agents-sa`.
- Argo reported `agents`, `agents-ci`, `jangar`, `symphony-jangar`, `symphony-torghut`, `torghut`, and
  `torghut-options` as `Healthy` and `Synced`.
- `kubectl get deploy -n agents -o wide` showed `agents=1/1`, `agents-alloy=1/1`, and `agents-controllers=2/2`.
- Recent Agents events showed a successful controller rollout, but also old readiness probe timeouts on the previous
  `agents` and `agents-controllers` pods and one transient Docker Hub TLS timeout while pulling the smoke-cleanup image.
- `kubectl get pods -n agents` showed the current scheduled swarm pods running and recent plan, implement, verify, and
  discover jobs succeeding. Failed verify pods from earlier runs still exist as failure debt.
- `kubectl get pods -n jangar -o wide` showed `jangar-bb95b96c9-s6r4j` at `2/2 Running`, `jangar-db-1` running, and
  Bumba, Alloy, Redis, Open WebUI, Symphony, and Symphony-Jangar running.
- `kubectl get events -n jangar` showed a recent Jangar rollout and a transient readiness failure before the new pod
  became ready.
- Jangar `/health` returned HTTP 200.
- Jangar `/api/agents/control-plane/status` reported `execution_trust.status=healthy`, `database.status=healthy`, and
  workflow/job runtimes configured.
- The same status route reported `agents-controller` and `supporting-controller` authority with `mode=rollout`, while
  `orchestration-controller` authority used `mode=heartbeat`.

### Database And Data Evidence

- Jangar Postgres connected as user `jangar` to database `jangar` at `2026-05-06T05:12:54Z`; 99 non-system tables were
  visible.
- `public.agent_runs` counted 141 `Failed`, 128 `Succeeded`, and 29 `Running` rows, with newest updates around
  `2026-05-06T05:12:54Z`.
- `agents_control_plane.resources_current` counted 3,155 failed `AgentRun` resources, 130 succeeded, 26 running, and
  12 templates. This is useful evidence, but it is also accumulated debt that should not authorize widening by itself.
- `agents_control_plane.component_heartbeats` had fresh rows expiring at `2026-05-06T05:15:13Z`, but those rows came
  from the Jangar app pod and marked `agents-controller`, `supporting-controller`, and `workflow-runtime` as
  `disabled`; `orchestration-controller` was `healthy`.
- `workflow_comms.agent_messages` was fresh, with `general/status` and `run/status` messages observed at
  `2026-05-06T05:11:28Z`.
- `torghut_control_plane.quant_metrics_latest` had fresh generic account rows through `2026-05-06T05:13Z`, while
  live account `PA3SX7FYNUTF` rows were stale from `2026-05-05T17:27Z` through `2026-05-05T19:13Z`.
- `torghut_control_plane.simulation_runs` remained stale: failed rows were latest on March 19, while succeeded,
  running, cancelled, and submitted rows were latest on March 13-14.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controller authority, runtime adapters, database
  consistency, rollout health, execution trust, and empirical service status. It is the right reducer boundary for
  action-class decisions.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already creates runtime-kit admission records and can
  become the enforcement boundary for dispatch ledgers.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 2,882 lines and owns schedule generation,
  supporting primitives, workspace storage, status reconciliation, and launch decisions. It should not grow another
  ad-hoc readiness interpretation.
- Jangar has regression coverage for control-plane status, runtime admission, heartbeat storage, heartbeat publishing,
  failure-domain leases, watch reliability, supporting-primitives controller behavior, and Torghut quant-health routes.
- The missing test gap is cross-source authority precedence: rollout-derived availability, heartbeat status, failed
  AgentRun debt, and Torghut capital-proof freshness must reduce to one stable action-class decision.

## Problem

Jangar currently has enough signals to recover, but the authority semantics are too permissive after partial recovery.

1. **Rollout health and controller heartbeat are different proofs.** A healthy Deployment proves pods can serve. It does
   not prove the controller loop that owns a specific action class is fresh and authoritative.
2. **Fallback authority is not typed by action.** Using rollout-derived health to keep repair lanes open is correct.
   Using the same fallback to widen normal dispatch or capital-adjacent workflow claims is too broad.
3. **Failed-run debt is still present.** The database has thousands of failed `AgentRun` resource rows and 141 failed
   public agent-run rows. That debt should be priced into admission instead of treated as background noise.
4. **Torghut should not parse Jangar internals.** Torghut needs a compact allow, repair-only, hold, or block decision,
   not a pile of controller, rollout, workflow, and simulation facts.
5. **Rollouts need safer degradation behavior.** When a new Jangar or Agents rollout temporarily loses readiness,
   dispatch widening should stop before the failure turns into more work, while bounded repair remains possible.

## Alternatives Considered

### Option A: Treat Healthy Rollout As Full Authority

This option accepts the current recovered state as sufficient. If `agents-controllers` is available and Jangar status is
healthy, all dispatch and Torghut consumers proceed.

Pros:

- Fastest path to throughput.
- Matches the status route's current optimistic behavior.
- Avoids a new persisted reducer.

Cons:

- Allows rollout fallback to over-authorize action classes that require heartbeat proof.
- Does not distinguish repair from normal dispatch.
- Leaves Torghut interpreting stale simulation and live-account quant evidence itself.

Decision: reject. It is acceptable for liveness and repair, not for normal dispatch or capital proof.

### Option B: Freeze Normal Dispatch Until All Heartbeats Agree

This option blocks normal dispatch and capital consumers whenever any controller heartbeat is disabled or stale.

Pros:

- Conservative.
- Easy to explain.
- Prevents fallback authority from widening risk.

Cons:

- Blocks the repair work needed to clear the evidence mismatch.
- Treats disabled Jangar-local heartbeats and unhealthy Agents controllers as the same failure.
- Encourages manual bypasses when the cluster is mostly healthy.

Decision: keep as an emergency switch, not the steady architecture.

### Option C: Dual-Authority Dispatch Ledger And Capital Proof Firewall

This option records both rollout-derived and heartbeat-derived authority, then reduces them by action class.

Pros:

- Preserves recovery throughput without pretending all proof is equal.
- Gives deployers a single ledger row to inspect for each dispatch class.
- Lets Torghut consume a compact capital-proof decision.
- Makes rollout fallback explicit and expiring.
- Reduces failure modes at the admission boundary instead of in each consumer.

Cons:

- Adds a new reducer, projection table, and regression matrix.
- Requires a shadow period so false holds do not starve schedules.
- Requires careful wording in Jangar UI so operators understand repair-only states.

Decision: select Option C.

## Chosen Architecture

### DispatchAuthorityLedger

Jangar should materialize one current ledger row per namespace, controller, runtime, action class, and source.

```text
dispatch_authority_ledger
  ledger_id
  namespace
  controller_name
  runtime_class                 # workflow, job, temporal, custom
  action_class                  # observe, repair, normal_dispatch, rollout_widen, merge_ready, capital_proof
  authority_source              # heartbeat, rollout, local_config, database_projection
  authority_state               # allow, repair_only, observe_only, hold, block
  confidence                    # high, medium, low
  observed_at
  fresh_until
  source_deployment
  source_pod
  rollout_revision
  heartbeat_status
  failed_run_debt_count
  blocking_reasons[]
  allowed_repair_scopes[]
  evidence_digest
```

Reducer rules:

- `observe` stays open when either rollout or heartbeat authority is fresh.
- `repair` stays open when rollout authority is fresh and the repair scope is bounded to known failed-run debt.
- `normal_dispatch` requires fresh rollout authority and either fresh heartbeat authority or an explicit shadow
  override during the first rollout phase.
- `rollout_widen` requires rollout authority, heartbeat authority, execution trust healthy, and no active API 429 or
  readiness probe hold.
- `merge_ready` requires normal dispatch allowed plus workflow/job runtime confirmation from the selected controller.
- `capital_proof` requires normal dispatch allowed plus fresh Torghut consumer data; rollout fallback alone can never
  authorize capital proof.

### CapitalProofFirewall

Jangar should expose a reduced Torghut-facing firewall decision:

```text
capital_proof_firewall
  firewall_id
  generated_at
  fresh_until
  jangar_dispatch_state         # allow, repair_only, observe_only, hold, block
  torghut_data_state            # fresh, stale, missing, contradictory
  quant_account_state           # account_fresh, generic_only, account_stale, account_missing
  simulation_state              # fresh, stale, unavailable
  permitted_torghut_actions[]   # observe, repair_metrics, repair_empirical, paper_candidate, live_candidate
  blocked_torghut_actions[]
  reason_codes[]
  source_ledger_ids[]
```

Torghut only consumes this reduced contract. It does not infer capital authority from Jangar route health.

## Implementation Scope

Engineer stage:

- Add a Jangar migration for `dispatch_authority_ledger` and `capital_proof_firewall`.
- Extend `control-plane-status.ts` to emit action-class reductions without changing the existing top-level status
  during shadow mode.
- Extend `control-plane-runtime-admission.ts` so schedule admission reads the ledger for `normal_dispatch` and
  `repair`.
- Add API output for the firewall under the existing Torghut quant control-plane surface.
- Add reducer tests for rollout-only, heartbeat-only, both-fresh, both-stale, failed-run-debt, and Torghut stale-account
  cases.
- Add one UI status badge that names `rollout-derived`, `heartbeat-derived`, or `repair-only`; do not hide the source.

Deployer stage:

- Roll out the ledger in shadow mode first.
- Compare ledger decisions against current status route decisions for at least one full swarm cycle.
- Enable repair enforcement before normal dispatch enforcement.
- Enable `capital_proof` enforcement only after Torghut's companion proof recovery ledger is live.

## Validation Gates

Local and CI gates:

- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-runtime-admission.test.ts`
- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-heartbeat-store.test.ts`
- `bunx oxfmt --check docs/agents/designs/102-jangar-dual-authority-dispatch-ledger-and-capital-proof-firewall-2026-05-06.md`

Cluster gates:

- Argo remains `Healthy` and `Synced` for `agents`, `jangar`, and `torghut`.
- `agents-controllers` remains available at desired replicas.
- Jangar status reports workflow and job runtimes configured.
- Ledger shadow output shows rollout-only authority as `repair_only` for capital proof.
- A forced heartbeat-stale fixture holds `normal_dispatch` while keeping bounded repair open.
- Torghut capital proof firewall returns `repair_only` when live account metrics are stale even if Jangar route health
  is green.

## Rollout Plan

1. Ship schema and reducers with `JANGAR_DISPATCH_AUTHORITY_LEDGER_MODE=shadow`.
2. Publish ledger rows from the status reducer every control-plane status refresh.
3. Add UI/API visibility and NATS status snippets for holds and repair-only decisions.
4. Enable repair enforcement for schedules that target failed-run debt.
5. Enable normal dispatch enforcement after one swarm cycle has no unexpected holds.
6. Enable capital proof enforcement after Torghut emits the companion live proof recovery ledger.

## Rollback Plan

- Set the ledger mode back to `shadow` to stop enforcement while preserving visibility.
- Disable the capital proof firewall consumer in Torghut and fall back to existing observe-only proof checks.
- Keep the schema; do not drop rows during rollback. The ledger is audit evidence and helps root-cause false holds.
- If ledger writes pressure Postgres, reduce publish frequency and keep in-memory status output until batching is added.

## Risks And Mitigations

- **False holds during partial recovery.** Mitigate with shadow mode and repair-only allowance.
- **Operators confuse rollout-derived health with failure.** Mitigate by labeling the source and explaining the allowed
  action class, not just the status.
- **Ledger row churn.** Mitigate by writing only on decision digest changes or expiry refresh.
- **Torghut overfits to Jangar internals.** Mitigate through the firewall contract; Torghut consumes decisions, not raw
  controller rows.
- **Old failed-run debt dominates forever.** Mitigate with age buckets and repair scopes so old debt does not block
  unrelated namespaces once explicitly acknowledged.

## Handoff Contract

Engineer acceptance:

- A unit test proves rollout authority alone allows `observe` and bounded `repair`, but blocks `capital_proof`.
- A unit test proves fresh heartbeat plus healthy rollout allows `normal_dispatch`.
- A unit test proves stale live-account quant metrics force `capital_proof_firewall.jangar_dispatch_state` or
  `torghut_data_state` into a non-capital state.
- Status output includes `authority_source` and `action_class` for every reduced decision.

Deployer acceptance:

- Shadow output is captured in Jangar for at least one full discover-plan-implement-verify cycle.
- Enforcing repair-only mode does not block failed-run cleanup or current scheduled status publication.
- Enforcing normal dispatch does not create a backlog spike.
- Capital proof enforcement is not enabled until Torghut's companion ledger reports account-fresh proof, empirical
  freshness, and broker-event reconciliation.
