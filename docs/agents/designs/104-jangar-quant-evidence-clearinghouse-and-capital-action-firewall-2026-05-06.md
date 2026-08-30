# 104. Jangar Quant Evidence Clearinghouse And Capital Action Firewall (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, action-class rollout authority, quant evidence freshness, empirical proof debt,
runtime trust, and Torghut capital-admission firewalling.

Companion Torghut contract:

- `docs/torghut/design-system/v6/108-torghut-capital-clearance-market-and-negative-evidence-ledger-2026-05-06.md`

Extends:

- `103-jangar-torghut-decision-custody-cells-and-rollout-proof-exchange-2026-05-06.md`
- `103-jangar-material-action-settlement-board-and-profit-repair-gates-2026-05-06.md`
- `101-jangar-typed-evidence-authority-and-readiness-debt-gates-2026-05-06.md`

## Decision

I am choosing a **quant evidence clearinghouse with a capital action firewall** as the next Jangar architecture step for
Torghut quant.

The current evidence says the control plane is no longer primarily down. Argo reports Jangar, Agents, and Torghut synced
and healthy at revision `8a130c3047a48c60c5c8bd96c3d8aeee95b9ac7c`. Jangar `/health` returns HTTP 200. Jangar
`/api/agents/control-plane/status?namespace=agents` reports `agents-controller`, `supporting-controller`, and
`orchestration-controller` healthy, workflow/job/Temporal adapters configured, execution trust healthy, database
healthy, and rollout health healthy for the configured `agents` and `agents-controllers` deployments.

That is not permission for live capital. The same Jangar status keeps `dependency_quorum.decision=block` with
`empirical_jobs_degraded`. The typed Torghut quant health endpoint returns HTTP 200 but `status=degraded`,
`latestMetricsCount=0`, `latestMetricsUpdatedAt=null`, `emptyLatestStoreAlarm=true`, and no pipeline stages for the
current scoped query. The Agents namespace still contains retained failure debt across Torghut/Jangar scheduled runs:
112 completed, 26 failed, and 4 running jobs in the current read. Torghut route health has recovered to new revisions,
but live capital remains intentionally blocked.

The selected design makes Jangar a clearinghouse for material-action evidence. Rollout health, execution trust, database
health, runtime adapter readiness, empirical proof freshness, quant latest-store state, and retained run debt are
reduced into one capital-action answer per consumer tuple. Jangar can keep observe and repair lanes open while
preventing any healthy rollout from widening Torghut live authority when proof is stale or empty.

The tradeoff is stricter capital admission. Some actions that would previously appear as "route available" become
`repair_only` or `shadow_only`. I accept that because route availability is a service property, not a profit property.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, or trading settings were changed during this assessment.

### Cluster And Rollout Evidence

- The run uses `system:serviceaccount:agents:agents-sa`; the local context was bootstrapped to `in-cluster` for
  read-only kubectl checks.
- `kubectl get applications -n argocd torghut jangar agents -o wide` showed `torghut`, `jangar`, and `agents` all
  `Synced` and `Healthy` at revision `8a130c3047a48c60c5c8bd96c3d8aeee95b9ac7c`.
- `kubectl get pods,deploy,svc -n jangar -o wide` showed Jangar, Bumba, Alloy, Postgres, Redis, Open WebUI, Symphony,
  and Symphony-Jangar running; `deployment/jangar` was `1/1`.
- `kubectl get pods,deploy,cronjobs,jobs -n agents -o wide` showed `agents=1/1` and `agents-controllers=2/2`, but also
  retained failure debt in Torghut/Jangar scheduled jobs.
- Aggregating current Torghut/Jangar scheduled jobs in `agents` returned `Complete 112`, `Failed 26`, `Running 4`.
- Recent events showed Torghut Knative startup/readiness probe flaps before `torghut-00232` and `torghut-sim-00313`
  became ready; Argo then marked Torghut healthy.
- `kubectl get pods -n temporal -o wide` showed `elasticsearch-master-1` pending while Temporal frontend/history/
  matching/worker were running.
- The wider cluster still has Ceph OSD pending risk (`rook-ceph-osd-0`, `rook-ceph-osd-1`, and `rook-ceph-osd-2`
  pending in the read), which matters to artifact durability even if the Jangar route is healthy.

### Jangar Control-Plane Evidence

- Jangar `/health` returned HTTP 200 with service status OK.
- Jangar control-plane status reported controller authority from rollout for `agents-controller` and
  `supporting-controller`, heartbeat authority for `orchestration-controller`, and runtime adapters `workflow`, `job`,
  and `temporal` available and configured.
- `execution_trust.status=healthy` and `rollout_health.status=healthy`; rollout health observed two configured
  deployments with zero degraded deployments.
- Jangar database status was healthy with Kysely migration consistency: 28 registered, 28 applied, zero unapplied, zero
  unexpected, latest applied `20260505_torghut_quant_pipeline_health_window_index`.
- The same status kept `dependency_quorum.decision=block`, reason `empirical_jobs_degraded`, so the controller is
  explicitly separating route health from dependency authority.

### Quant Evidence And Data Surface

- Jangar typed Torghut quant health returned `status=degraded`, `latestMetricsCount=0`, `latestMetricsUpdatedAt=null`,
  `emptyLatestStoreAlarm=true`, `missingUpdateAlarm=false`, `metricsPipelineLagSeconds=null`, `stageCount=0`, and
  `pipelineHealthScoped=true`.
- Direct CNPG status reads for `torghut-db` and `jangar-db` are forbidden to this service account.
- Direct pod exec into Torghut Postgres and ClickHouse is forbidden to this service account.
- Torghut `/db-check` is available as a read-only projection and reports schema current at
  `0029_whitepaper_embedding_dimension_4096`.
- Torghut ClickHouse guardrails exporter reports both ClickHouse replicas up, both not read-only, high disk-free ratios
  near 0.97, and the last scrape successful.
- Torghut LLM guardrails exporter reports last scrape success, LLM disabled, effective shadow mode enabled, rollout
  stage `stage3`, policy classification compliant, and governance evidence incomplete.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the reducer boundary that already composes controller
  authority, runtime adapters, database status, rollout health, execution trust, workflows, empirical services, and
  dependency quorum.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` already exposes typed quant-health
  state, including latest-store emptiness, missing-update alarms, runtime enablement, stage lookback, and stage lag.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` and adjacent runtime files are the durable projection
  boundary for latest account/window metrics and pipeline health.
- Tests exist for control-plane status, runtime admission, empirical services, failure-domain leases, quant health,
  quant metrics store, quant runtime materialization, and Torghut simulation control-plane behavior.
- The missing architecture-level regression is a single Jangar reducer that proves healthy rollout plus healthy
  execution trust plus empty quant latest store plus stale empirical jobs cannot emit live-capital clearance.

## Problem

Jangar currently exposes many useful facts, but Torghut still needs one action-class decision before capital can move.

1. Rollout health can be green while capital evidence is stale or empty.
2. Quant health can be reachable but degraded because the latest account/window store is empty.
3. Empirical job debt can be retained across scheduled runs without a clear capital price.
4. Runtime adapter availability can be mistaken for permission to execute material actions.
5. Direct DB reads are not always available to the agent lane, so Jangar has to publish safe projections that do not
   depend on operators having pod exec or CNPG privileges.

The next control-plane improvement should not be another raw status panel. It should reduce failure modes before they
reach Torghut sizing.

## Alternatives Considered

### Option A: Keep The Existing Dependency Quorum As The Only Capital Gate

Pros:

- Reuses a reducer that already blocks on `empirical_jobs_degraded`.
- Requires the smallest implementation.
- Keeps the status surface familiar.

Cons:

- Does not price quant latest-store emptiness separately from other dependency problems.
- Does not emit per-account, per-hypothesis, per-action clearance.
- Does not distinguish observe, repair, shadow, paper, live micro-canary, and live scale authority.
- Leaves Torghut to join several status surfaces before deciding whether to size.

Decision: reject as the target architecture. It is a necessary input, not a clearinghouse.

### Option B: Freeze Torghut Capital Until Every Cluster And Data Risk Is Green

Pros:

- Strong capital protection.
- Easy operational explanation.
- Avoids accidental live widening while Temporal or storage risks exist.

Cons:

- Blocks useful shadow data collection.
- Treats retained historical job failures the same as current live blockers.
- Gives no repair authority to retire proof debt.
- Encourages manual overrides because the system cannot express scoped risk.

Decision: keep as an emergency fallback, not the default operating model.

### Option C: Quant Evidence Clearinghouse With Capital Action Firewall

Pros:

- Converts many status surfaces into a single action-class clearance.
- Preserves observe and repair work during degraded proof windows.
- Blocks live capital when quant latest store is empty, empirical jobs are stale or missing, rollout health degrades, or
  execution trust regresses.
- Gives Torghut a narrow contract that can be consumed before sizing.
- Makes safer rollout behavior explicit: healthy rollout allows route use, not capital expansion.

Cons:

- Adds a new reducer and projection contract.
- Requires careful tests so retained audit failures do not permanently block current repair lanes.
- Needs deployer discipline to run shadow comparisons before enforcement.

Decision: select Option C.

## Chosen Architecture

Jangar will publish a `capital_action_clearance` projection for each material-action tuple:

```text
capital_action_clearance
  clearance_id
  consumer                         # torghut
  namespace
  account_label
  hypothesis_id
  strategy_id
  action_class                     # observe, repair, shadow_decide, paper_canary, live_micro_canary, live_scale
  rollout_health_state             # healthy, degraded, unknown
  execution_trust_state            # healthy, degraded, blocked, unknown
  runtime_adapter_state            # configured, degraded, unavailable
  database_projection_state        # healthy, degraded, unknown
  empirical_state                  # fresh, stale, missing, not_required
  quant_latest_state               # fresh, stale, empty, missing, not_required
  scheduled_run_debt               # none, retained, active_failed, active_retrying
  infrastructure_pressure_state    # normal, yellow, red
  decision                         # allow, repair_only, shadow_only, hold, block
  max_notional
  max_order_count
  fresh_until
  reason_codes[]
  evidence_refs[]
```

Reducer rules:

- `observe` is allowed when the Jangar route is reachable and the request is read-only.
- `repair` is allowed when rollout health is healthy or degraded-but-stable and the repair scope is bounded to proof
  refresh or job retry.
- `shadow_decide` is allowed when Torghut route dependencies are healthy but empirical or quant evidence is stale,
  empty, or optional.
- `paper_canary` requires fresh empirical jobs, non-empty scoped quant latest-store state, healthy execution trust, and
  no active failed scheduled run for the same clearance tuple.
- `live_micro_canary` requires `paper_canary` plus explicit broker-event reconciliation freshness, TCA freshness, and a
  Jangar rollout state that has stayed healthy through the shadow comparison window.
- `live_scale` requires live micro-canary settlement, positive post-cost evidence, and no unresolved rollback rehearsal
  debt.
- Any empty latest store, stale empirical proof, blocked execution trust, degraded rollout health, unhealthy database
  projection, or red infrastructure pressure downgrades live actions to `shadow_only`, `repair_only`, or `block`.

The firewall is action-class based. A problem in capital evidence does not have to stop observation or proof repair. It
does stop live notional authority.

## Validation Gates

Engineer acceptance:

- Add a Jangar reducer test where rollout and execution trust are healthy, but quant latest store is empty; expected
  `live_micro_canary` decision is `shadow_only` or `block`, never `allow`.
- Add a reducer test where empirical jobs are stale for a candidate; expected live actions are blocked while
  `repair_only` remains open.
- Add a reducer test where a retained historical failed job exists outside the active debt window; expected repair lanes
  are allowed but live scale remains blocked until the debt window is retired.
- Add a status API contract test proving clearance records include `fresh_until`, `reason_codes`, and evidence refs.
- Add a UI/API fixture proving action-class state is visible without requiring pod exec or CNPG privileges.

Deployer acceptance:

- Jangar `/api/agents/control-plane/status` must keep `execution_trust.status=healthy` and configured workflow/job/
  Temporal adapters before any clearance is enforced.
- Jangar typed quant health must report a non-empty latest store for the target account/window before `paper_canary` or
  live classes can clear.
- Torghut empirical jobs must be fresh or explicitly repaired before live classes can clear.
- A full shadow session must compare clearinghouse decisions with the current dependency quorum and Torghut live
  submission gate.
- If Temporal search or storage pressure is degraded, the clearinghouse must reduce live action class even when route
  rollout is green.

## Rollout

1. Implement the clearinghouse reducer and emit it in observe mode.
2. Add the clearance projection to Jangar status and a typed Torghut-facing endpoint.
3. Run one market-session shadow comparison against current Torghut readiness, empirical, quant, and profitability
   surfaces.
4. Enforce the firewall for `live_micro_canary`; keep observe, repair, and shadow decisions available.
5. Enforce `paper_canary` and `live_scale` only after Torghut consumes the contract before sizing.

## Rollback

- If clearance computation fails, Jangar must return no live clearance and keep repair-only guidance.
- If quant latest store becomes empty, downgrade paper and live classes to `shadow_only`.
- If empirical jobs become stale or missing, downgrade live classes to `repair_only` plus shadow.
- If execution trust becomes degraded or blocked, block all live classes.
- If rollout health degrades during enforcement, set live classes to `hold`.
- If the clearinghouse causes false blocks, disable enforcement while retaining observe-mode projection and evidence.

## Risks

- The reducer can be too strict and starve experiments. Mitigation: preserve `shadow_decide` when route and source data
  are healthy.
- The reducer can be too loose if quant health is reachable but empty. Mitigation: treat empty scoped latest store as a
  capital blocker, not a warning.
- Historical failure debt can dominate current state. Mitigation: separate retained audit debt from active blocking debt
  by tuple and freshness window.
- The new projection can duplicate existing dependency quorum semantics. Mitigation: make quorum an input and make the
  clearinghouse decision action-class specific.

## Handoff Contract

Engineer stage owns the reducer, projection schema, status/API contract, and tests above. The implementation should be a
small Jangar module that consumes existing status providers instead of spreading capital logic across route handlers.

Deployer stage owns the shadow comparison, enforcement toggle, and rollback watch. Do not widen Torghut capital from
Jangar route health alone. Widen only from a fresh clearance for one account, one hypothesis, one strategy, one action
class, and one explicit notional cap.
