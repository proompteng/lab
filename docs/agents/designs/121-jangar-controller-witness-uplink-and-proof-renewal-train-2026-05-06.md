# 121. Jangar Controller Witness Uplink And Proof Renewal Train (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders
Scope: Jangar controller-witness closure, dispatch graduation, proof-renewal sequencing, Torghut capital gates,
rollout safety, and deployer acceptance evidence.

Companion Torghut contract:

- `docs/torghut/design-system/v6/125-torghut-proof-renewal-train-and-capital-reentry-sequencer-2026-05-06.md`

Extends:

- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `120-jangar-data-plane-proof-quarantine-and-profit-repair-fuse-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`
- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`

## Decision

I am selecting a **controller witness uplink plus proof renewal train** as the next Jangar architecture step.

The current system has moved past the earlier broad outage shape. At `2026-05-06T15:12Z`, Jangar, Agents, and Torghut
were serving. `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, `deployment/jangar` was
`1/1`, Jangar `/ready` returned HTTP `200`, execution trust was healthy, runtime kits were healthy, NATS was present,
and the database projection reported `28/28` Kysely migrations applied. Argo CD reported `agents` and `jangar`
`Synced` and `Healthy`; it reported `torghut` `OutOfSync` but `Healthy` at revision
`c61316511cafdea2315d4beea145b3b489c6209a`.

The remaining control-plane risk is more precise. Jangar's serving process still reports
`agentrun_ingestion.status=unknown` with message `agents controller not started`. The same status payload says the
controller deployment is available and the watch epoch is current, but `controller_self_report_current=false`, so
`control_plane_controller_witness.decision=repair_only` with reason `controller_witness_split`. Jangar therefore
allows `serve_readonly`, `dispatch_repair`, `deploy_widen`, and `torghut_observe`, but it keeps `dispatch_normal` at
`repair_only`, holds `merge_ready` and `paper_canary`, and blocks `live_micro_canary` and `live_scale`.

That is the correct safety posture, but it is not a durable operating model. A healthy controller deployment plus a
fresh watch stream should not depend on an HTTP serving process guessing whether another pod's ingestion loop is
running. The controller that owns AgentRun ingestion must publish a small, signed, expiring self-report into a shared
witness surface. Jangar then graduates normal dispatch only when deployment witness, watch witness, and controller
self-report all agree for the same controller generation.

The proof renewal train sequences the work unlocked by that closure. First repair the controller witness split. Then
renew Torghut empirical proof. Then refill account/window quant latest metrics. Then refresh market-context domains.
Paper and live capital stay held or blocked until the train emits closure receipts for the exact action class.

The tradeoff is another explicit handoff between controller pods and the serving API. I accept that. Six months from
now, Jangar needs fewer ambiguous control-plane interpretations, not more status text that humans reconcile during an
incident.

## Evidence Snapshot

All checks for this decision were read-only. I did not mutate Kubernetes resources, database records, trading flags,
broker state, Argo applications, or GitHub records.

### Cluster And Rollout Evidence

- Runtime Kubernetes identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset, but in-cluster authentication worked for read-only checks.
- Namespaces `agents`, `jangar`, and `torghut` were `Active`.
- `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, and `deployment/agents-alloy` was `1/1`.
- `deployment/jangar`, `deployment/bumba`, `deployment/jangar-alloy`, `deployment/symphony`, and
  `deployment/symphony-jangar` were available.
- Torghut live revision `torghut-00238` was `2/2 Running`; sim revision `torghut-sim-00331` was `2/2 Running`.
- `torghut-ta-sim`, its four task managers, live TA, options TA, options catalog, options enricher, ClickHouse,
  Keeper, Postgres, websockets, guardrail exporters, Alloy, and Symphony were running.
- The earlier `torghut-ta-sim` image/platform failure had recovered into a running deployment. Recent Torghut events
  still showed its rollout churn, transient scheduling failures, duplicate ClickHouse PodDisruptionBudget matches, and
  a Flink status-modified warning for `torghut-options-ta`.
- Recent agents events still showed readiness probe timeouts against `agents`, both `agents-controllers` pods, and
  older controller pods, even though the current deployments were available.
- Argo CD reported `agents`, `jangar`, `torghut-options`, `symphony-jangar`, and `symphony-torghut` as `Synced` and
  `Healthy`; it reported `torghut` as `OutOfSync` and `Healthy`.
- This service account cannot list `statefulsets.apps`, `rollouts.argoproj.io`, or Knative services in the target
  namespaces. That limits direct rollout evidence and reinforces the need for service-owned witness projections.

### Database, Data, And Freshness Evidence

- Direct CNPG `psql` against `jangar-db` and `torghut-db` failed because the agents service account cannot create
  `pods/exec` in those namespaces. The smallest unblocker for direct read-only SQL is a constrained read-only database
  credential or a read-only exec role; the ordinary lane should keep using service-owned projections.
- Jangar control-plane status reported database `configured=true`, `connected=true`, `status=healthy`,
  `latency_ms=3`, registered migrations `28`, applied migrations `28`, no missing migrations, and latest applied
  migration `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar watch reliability was healthy over 15 minutes with `1267` events, `0` errors, and `0` restarts in the sampled
  payload.
- Jangar dependency quorum returned `decision=block` with reason `empirical_jobs_degraded`.
- `agentrun_ingestion.status=unknown`; controller witness quorum returned `repair_only` for `controller_witness_split`.
- Jangar material action activation receipts allowed `serve_readonly`, `dispatch_repair`, `deploy_widen`, and
  `torghut_observe`; set `dispatch_normal=repair_only`; held `merge_ready` and `paper_canary`; and blocked
  `live_micro_canary` and `live_scale`.
- Jangar empirical services reported forecast `degraded` with `registry_empty`, lean `disabled`, and stale empirical
  jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Jangar typed quant health for `account=paper&window=1d` was degraded with `latestMetricsUpdatedAt=null`,
  `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.
- Torghut live `/healthz` returned HTTP `200`, but `/readyz` returned HTTP `503` because live submission was blocked by
  `simple_submit_disabled` in `capital_stage=shadow`.
- Torghut live `/readyz` reported Postgres, ClickHouse, Alpaca, database schema, and Jangar universe healthy. The
  schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`; lineage was ready with known
  historical parent-fork warnings.
- Torghut `/trading/status` reported `3` hypotheses, `0` promotion eligible, `3` rollback required, and dependency
  quorum `block`.
- Torghut market context for `NVDA` had fresh technicals and regime at `2026-05-06T15:12:49Z`, but fundamentals were
  stale from `2026-03-12T13:43:18Z` and news was stale from `2026-05-06T13:43:23Z`.
- The cluster-level market-context health bundle was degraded, with stale technicals, fundamentals, news, and regime in
  the cached aggregate before the symbol-specific lookup refreshed technicals and regime.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `753` lines and composes controller health, database status,
  rollout health, watch reliability, runtime admission, empirical services, failure-domain leases, negative evidence,
  controller witness quorum, action clocks, activation receipts, and execution trust.
- `services/jangar/src/server/control-plane-controller-witness.ts` is `423` lines and already models serving-process,
  deployment, watch-epoch, and AgentRun-ingestion witnesses. It can detect `controller_witness_split`, but it does not
  yet consume an authoritative controller-pod self-report.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already downgrades normal
  dispatch for `controller_witness_split`, stale empirical jobs, Torghut readiness, market-context debt, quant alerts,
  workflow failures, and rollout ambiguity.
- `services/jangar/src/server/supporting-primitives-controller.ts` is `2883` lines and remains the largest high-risk
  control-plane module. It owns schedule runners, runner ConfigMaps, CronJobs, workspace state, PVC lifecycle,
  requirements, freezes, and swarm admission.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already builds live submission gates from
  dependency quorum, empirical readiness, typed quant health, hypothesis runtime state, and capital stage.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns market-context observations, signal
  continuity, rejection accounting, LLM decision context, and order preparation.
- Focused tests exist for Jangar status, controller witness, negative evidence routing, action clocks, runtime
  admission, watch reliability, empirical services, Torghut empirical jobs, market context, submission council,
  trading health, and quant readiness. The missing regression is end-to-end proof renewal ordering: normal dispatch
  must not graduate before a fresh controller self-report, and Torghut capital repairs must not run ahead of that
  closure.

## Problem

Jangar now has enough safety surfaces to avoid acting on stale proof, but it still lacks a clean closure path for one
of its own safety surfaces.

The current controller witness split is not a deployment outage. The controller deployment is available. The watch
stream is current. The serving process is healthy. The missing fact is the one only the controller process can honestly
publish: "I am the controller generation that owns AgentRun ingestion, I have seen or resynced the current runs, and
this self-report expires at a known time."

Without that self-report, Jangar should remain conservative. But if the architecture stops there, every downstream
repair competes under a permanent `dispatch_normal=repair_only` cap. Torghut then has a pile of truthful but stale
proof: March 21 empirical artifacts, empty account/window quant latest metrics, and stale non-technical market
context. Those repairs need ordering, not a generic queue.

The six-month failure mode is repeated partial recovery: rollouts become healthy, routes answer, but capital stays
stuck because each proof gap is repaired independently and no single train settles the predecessor gates.

## Alternatives Considered

### Option A: Treat Rollout Health As Sufficient Controller Authority

If `deployment/agents-controllers` is available and watch reliability is healthy, Jangar could ignore
`agentrun_ingestion.status=unknown` and return `dispatch_normal=allow`.

Pros:

- Fastest way to remove repair-only dispatch.
- Uses evidence that already exists in the status payload.
- Avoids new controller writes or shared witness storage.

Cons:

- Deployment availability does not prove the ingestion loop is current.
- It weakens the controller witness design immediately after adding it.
- It can allow normal dispatch when the active controller has not published its own ingestion epoch.
- It gives deployers less evidence during controller rollouts and restarts.

Decision: reject. This is how route-local authority returns under a new name.

### Option B: Keep Repair-Only Until Humans Manually Certify The Controller

Operators could inspect logs, pods, and events, then mark a runbook checklist complete before normal dispatch resumes.

Pros:

- No new runtime contract.
- Keeps the system conservative.
- Useful as an emergency manual path.

Cons:

- Does not help automated swarm operation.
- Makes every recovery depend on a human reconstructing distributed state.
- Cannot be regression-tested as a first-class material action input.
- Does not sequence Torghut proof renewal after controller closure.

Decision: reject as the primary path. Keep manual certification only as a break-glass fallback.

### Option C: Controller Witness Uplink And Proof Renewal Train

Controller pods publish an expiring self-report into a shared witness table or ConfigMap. Jangar reduces deployment,
watch, serving, and self-report witnesses into a controller-witness closure receipt. Only after that receipt is
current does normal dispatch graduate. A proof renewal train then admits ordered repair work for empirical proof, quant
latest metrics, and market context.

Pros:

- Makes the missing controller fact explicit and testable.
- Preserves conservative dispatch while providing an automatic exit.
- Gives deployers a single closure receipt for controller safety.
- Lets Torghut repairs run in dependency order instead of competing as unrelated jobs.
- Keeps paper and live capital gates bound to Jangar material action receipts.

Cons:

- Adds a small controller-pod write path.
- Requires stale self-reports to expire quickly and fail closed.
- Requires migration or ConfigMap ownership decisions before implementation.

Decision: select Option C.

## Architecture

Jangar adds a `controller_ingestion_self_report` projection. The preferred storage is the Jangar database because the
serving process already has DB projection health and migration consistency in the status payload. A ConfigMap fallback
is acceptable only for the first rollout ring if DB write coupling is judged too risky.

```text
controller_ingestion_self_report
  report_id
  controller_generation
  controller_pod_uid
  controller_image_ref
  namespace
  observed_at
  expires_at
  last_watch_event_at
  last_resync_at
  observed_run_count
  untouched_run_count
  oldest_untouched_age_seconds
  leader_identity
  producer_revision
  signature
```

The controller process writes the report after each successful watch event batch and after each full resync. The report
expires after five minutes by default. A report is invalid when the controller deployment generation, pod UID, or image
does not match the current rollout witness.

Jangar then emits a `controller_witness_closure_receipt`.

```text
controller_witness_closure_receipt
  receipt_id
  generated_at
  expires_at
  namespace
  deployment_witness_ref
  watch_epoch_ref
  serving_process_ref
  controller_self_report_ref
  decision                 # allow, repair_only, block
  reason_codes
  graduation_scope         # dispatch_repair, dispatch_normal, deploy_widen
  rollback_target
```

The proof renewal train consumes this receipt before admitting downstream repairs.

```text
proof_renewal_train
  train_id
  generated_at
  expires_at
  controller_closure_ref
  train_state              # blocked, controller_repair, empirical_repair, quant_repair, context_repair, paper_ready
  repair_slots
  required_closure_receipts
  material_action_receipt_refs
  torghut_capital_scope
```

Train order is fixed until the first stable implementation proves otherwise:

1. `controller_repair`: publish a fresh controller self-report and clear `controller_witness_split`.
2. `empirical_repair`: refresh `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
   `janus_hgrm_reward` for the active candidate and dataset.
3. `quant_repair`: refill typed account/window latest metrics for paper and sim scopes.
4. `context_repair`: refresh fundamentals/news and aggregate market-context health for traded symbols.
5. `paper_ready`: emit paper-capital closure receipts and keep live-capital blocked until paper settlement exists.

## Implementation Scope

Engineer stage:

- Add the controller self-report writer in the agents controller process.
- Add the DB migration or ConfigMap schema for the self-report.
- Extend `control-plane-controller-witness.ts` to consume self-reports and emit closure receipts.
- Keep `controller_witness_split` when the self-report is missing, expired, or mismatched to the deployment generation.
- Add the proof renewal train reducer in Jangar status projection.
- Expose train state, next repair slot, and closure receipt refs through `/api/agents/control-plane/status`.
- Add tests for missing, expired, mismatched, and valid controller self-reports.
- Add tests proving `dispatch_normal` graduates only when the closure receipt allows.

Deployer stage:

- Roll out the self-report writer in shadow first.
- Confirm the report appears with the current controller image and pod UID.
- Confirm `control_plane_controller_witness.decision` moves from `repair_only` to `allow` only after the report is
  fresh.
- Confirm `dispatch_normal` graduates without changing `paper_canary`, `live_micro_canary`, or `live_scale` while
  empirical and quant proof remain stale.
- Confirm rollback by disabling the self-report writer or expiring the report returns `dispatch_normal=repair_only`.

## Validation Gates

- Unit: controller-witness reducer handles missing, stale, mismatched, and valid self-reports.
- Unit: negative-evidence routing keeps `dispatch_normal=repair_only` when controller closure is absent.
- Unit: material action activation receipts cite the controller closure receipt.
- Unit: proof renewal train remains `controller_repair` until `controller_witness_split` clears.
- Integration: Jangar status includes a fresh self-report after controller resync without making live capital allowed.
- Integration: Torghut paper remains held while empirical jobs are stale even after controller closure.
- Rollout: Argo `agents` and `jangar` stay `Synced` and `Healthy`.
- Rollback: disabling self-report publication reintroduces `controller_witness_split` within one expiry window.

## Rollout Plan

1. Ship the self-report schema and writer disabled by default.
2. Enable writer in shadow for one controller replica and log report freshness.
3. Enable writer for both controller replicas and require generation/pod matching.
4. Switch controller witness closure from observe to warn.
5. Switch `dispatch_normal` graduation to enforce after two consecutive expiry windows without false positives.
6. Start the proof renewal train in shadow and compare it with current repair admission.
7. Enforce train order for dispatch-capable repair slots.

## Rollback

Rollback is intentionally narrow:

- Disable self-report enforcement and keep existing controller witness split behavior.
- Keep `dispatch_normal=repair_only` until deployment and watch evidence are manually accepted.
- Do not relax `paper_canary`, `live_micro_canary`, or `live_scale`; those remain governed by empirical, quant,
  market-context, and settlement evidence.
- Preserve emitted self-report rows or ConfigMap versions for audit, but stop consuming them in final action receipts.

## Risks

- A controller may publish stale self-reports if the writer is not coupled to real watch/resync success. Mitigation:
  write only after successful watch batch or resync and include observed counters.
- Clock skew can make reports appear fresh incorrectly. Mitigation: use server-side DB timestamp when DB-backed.
- ConfigMap fallback can introduce Kubernetes write contention. Mitigation: prefer DB and keep ConfigMap fallback
  single-writer.
- The train can over-serialize repair work. Mitigation: allow parallel work only when a repair has no dependency on a
  predecessor closure receipt.

## Handoff Contract

Engineer acceptance:

- A fresh controller-pod self-report exists and expires.
- Controller witness closure cites deployment, watch, serving, and self-report refs.
- `dispatch_normal` cannot be `allow` without controller closure.
- Proof renewal train reports `controller_repair`, then empirical, quant, context, and paper readiness in order.
- Tests cover all reducer and receipt transitions.

Deployer acceptance:

- Read-only evidence shows current controller closure after rollout.
- `dispatch_repair` remains available during closure work.
- `dispatch_normal` graduates only after closure and drops back within one expiry window after writer disablement.
- Torghut paper and live gates stay held or blocked until their own closure receipts exist.
