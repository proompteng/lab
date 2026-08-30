# 165. Jangar Proof Settlement Broker And Profit Repair Packet Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, runtime proof settlement, retained failure triage, safer rollout, Torghut profit
repair admission, validation, rollback, and stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md`

Extends:

- `164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md`
- `163-jangar-scoped-evidence-debt-and-retained-failure-quarantine-2026-05-07.md`
- `150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`
- `docs/torghut/design-system/v6/168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`

## Decision

I am selecting a **proof settlement broker with profit repair packet gates** as the next Jangar control-plane
architecture step.

The current platform is not in a hard outage. Jangar serving pods are running, the agents controllers are available,
Torghut live and simulation revisions are ready, and both Jangar and Torghut database schema projections are current.
The failure mode is now cross-plane settlement drift. The agents namespace still carries 38 `Error` pods and 14 failed
jobs. Recent events show controller readiness timeouts, scheduler placement pressure, and a Torghut verify pod blocked
by missing input/spec ConfigMaps. Jangar status reports healthy database migration consistency and healthy watch
reliability, but dependency quorum blocks on `empirical_jobs_degraded`. Torghut `/trading/health` is degraded because
the profitability proof floor is `repair_only`, capital is `zero_notional`, market context is stale, alpha readiness
has zero promotion-eligible hypotheses, TCA route evidence is incomplete, and the quant health consumer still sees
`quant_pipeline_stages_missing`.

The design answer is to make Jangar the settlement broker for runtime proof, not only the observer of proof. Every
material action class must carry a settled proof packet that identifies the active failure fingerprint, the proof source
that can retire it, the consumer that depends on it, and the exact repair budget allowed while it remains unresolved.
Jangar will keep serving and observation open when route and database evidence are current, but normal dispatch,
deploy widening, merge-ready, paper canary, and live capital stay held until the relevant proof packet is settled by a
fresh receipt.

The tradeoff is stricter admission. A green rollout and a green database projection will not clear a stale empirical
job, missing ConfigMap, empty scoped quant store, or incomplete route TCA proof. I accept that because the next six
months of reliability depends on reducing false green states. Operators need to know not just that something is
degraded, but which repair packet clears the hold and which action classes remain off limits.

## Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` emits `proof_settlement_broker`.
- Each broker payload includes `broker_id`, `namespace`, `generated_at`, `fresh_until`, `cluster_receipts`,
  `data_receipts`, `runtime_contract_receipts`, `proof_packets`, `action_class_verdicts`, and `next_repair_queue`.
- The first packets cover at least these live failure families: retained failed AgentRun jobs, missing runner
  ConfigMaps, controller readiness brownouts, empirical job degradation, scoped quant health missing stages, Torghut
  market-context staleness, execution TCA route incompleteness, and alpha-readiness zero promotion.
- `serve_readonly` and `torghut_observe` remain allowed when database and route observation are fresh.
- `dispatch_repair` is allowed only for a named packet with one failure family, one owner surface, one repair receipt,
  max attempts, max runtime, and explicit rollback target.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  or blocked while any mandatory packet is unsettled, stale, contradicted, or missing a runtime receipt.
- Torghut route-reacquisition work consumes packet IDs and reports whether a repair increased routeable symbols,
  reduced TCA debt, refreshed market context, or produced promotion-eligible alpha evidence.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database
records, secrets, GitOps resources, AgentRuns, broker state, or Torghut flags.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-jangar-control-plane-plan`, based on `main`.
- `kubectl auth whoami` identified `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were running: `jangar` was `2/2`, `jangar-db-1` was `1/1`, and Bumba, Symphony, OpenWebUI,
  Redis, and Alloy were available.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents pod summary was 173 `Completed`, 38 `Error`, and 8 `Running`. Jobs were 172 `Complete`, 14 `Failed`, and 3
  `Running`.
- Recent agents events showed readiness probe timeouts for `agents` and both controller replicas, scheduler placement
  warnings, and `FailedMount` for a Torghut verify pod because expected input/spec ConfigMaps were missing.
- Current schedule CronJobs are active and unsuspended for Jangar discover, plan, implement, verify and Torghut quant
  discover, plan, implement, verify. The latest Jangar plan cron scheduled at `2026-05-07T21:20:00Z`.
- Torghut live `torghut-00284-deployment` and sim `torghut-sim-00384-deployment` were both `1/1` on image digest
  `sha256:014b9a46cd6690a9fd689b2e5cb170c35148c258358dfe53f3b86a46977c8421`.
- Torghut events showed repeated startup/readiness probe failures during recent revisions before the latest live and
  sim revisions settled ready.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and already assembles database consistency,
  controller health, watch reliability, execution trust, source rollout truth, runtime admission, and material action
  verdicts.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 3314 lines and owns schedule runner generation,
  runtime admission refresh, AgentRun template scheduling, workspace PVC reconciliation, and supporting primitive
  watches. This is the highest-risk source seam because it combines admission, generated scripts, and runtime creates.
- The generated schedule runner now separates schedule namespace from pod namespace and refreshes admission/runtime
  proof before create. Retained old failures still stay visible after newer cron jobs complete, so Jangar needs
  settlement classification instead of broad cleanup.
- `services/jangar/src/server/agents-controller/job-runtime.ts` is 772 lines. It creates input and run-spec
  ConfigMaps before creating a Job, then mounts them into runner pods. The current missing-ConfigMap event proves this
  path needs a packet-level receipt that ties ConfigMap creation, Job creation, and pod mount success together.
- `services/jangar/src/server/agents-controller/index.ts` is 1827 lines and already tracks AgentRun ingestion,
  resyncs, idempotency, status, and artifact limits. Broker work should consume these receipts, not duplicate the
  controller.
- `services/torghut/app/main.py` is 4188 lines and emits `/db-check`, `/readyz`, `/trading/status`, and
  `/trading/health` evidence. `services/torghut/app/trading/submission_council.py` already consumes Jangar typed quant
  health and turns missing stages into `quant_pipeline_stages_missing`.

### Database And Data Evidence

- Direct `pods/exec`, CNPG cluster list, and secret listing were forbidden to this worker in `jangar` and `torghut`.
  The exact exec error was `cannot create resource "pods/exec"` for `jangar-db-1` and `torghut-db-1`. The smallest
  unblocker for direct SQL is read-only `pods/exec` or a read-only database credential; this design does not require
  either for implementation.
- Jangar `/api/agents/control-plane/status` reported database `configured=true`, `connected=true`, `status=healthy`,
  latency `3 ms`, 28 registered migrations, 28 applied migrations, no unexpected migrations, and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar dependency quorum returned `decision=block` with reason `empirical_jobs_degraded`.
- Jangar watch reliability was healthy: 4 observed streams, 4490 events, 0 errors, and 3 restarts in the 15-minute
  window. AgentRun watch events were fresh at `2026-05-07T21:24:22Z`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, one schema branch, and lineage ready.
  The schema graph still warns about parent forks at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Jangar typed quant health for `account=paper&window=1d` returned `status=degraded`, `latestMetricsCount=0`,
  `emptyLatestStoreAlarm=true`, and no pipeline stages.
- Torghut `/trading/health` returned HTTP 503 with status `degraded`. Postgres, ClickHouse, Alpaca, schema, universe,
  and readiness cache were healthy, while live submission was disabled, proof floor was `repair_only`, market context
  was stale, TCA route universe was incomplete, scoped quant evidence had no stages, and capital stayed zero notional.
- Torghut `/trading/status` reported active revision `torghut-00284`, signal lag 1757 seconds as expected market-closed
  staleness, 7334 TCA orders, average absolute slippage about 13.82 bps, zero unsettled executions, one probing symbol,
  four blocked symbols, and three missing route symbols.

## Problem

Jangar has strong ingredients but weak settlement semantics. The control plane can answer whether a route is healthy,
whether a database migration set is current, whether a controller is available, and whether Torghut should hold
capital. It cannot yet make these facts settle into a durable repair packet that operators and downstream consumers can
use as the unit of work.

That gap creates five failure modes:

1. **Retained failure ambiguity**: old failed pods and jobs remain visible, but the system does not say whether they
   are active blockers, superseded audit records, or proof debt.
2. **ConfigMap-to-Job split**: a runner Job can exist while its mounted ConfigMap is missing. The evidence is in events,
   not in a first-class proof receipt.
3. **Scoped data mismatch**: unscoped quant or rollout health can look acceptable while account/window data is empty.
4. **Capital repair drift**: Torghut can name zero-notional blockers, but Jangar does not yet issue the repair packet
   that ties the blocker to a bounded runtime action.
5. **Rollback uncertainty**: a failed repair does not have one canonical packet to retire, rollback, or requeue.

## Alternatives Considered

### Option A: Scheduler And Garbage-Collection Hardening

Tighten CronJob history limits, delete old failed pods faster, and add more schedule-runner retry logic.

Advantages:

- Reduces operator noise quickly.
- Directly targets visible failed pods and jobs.
- Smaller implementation surface than a broker.

Disadvantages:

- Deletes or hides evidence without classifying it.
- Does not solve scoped quant, market-context, or TCA repair admission.
- Does not give Torghut a profit-aware repair unit.

Decision: useful follow-up, but not sufficient as the architecture.

### Option B: Torghut-Only Profit Repair Board

Let Torghut own all routeability and profit repair decisions, with Jangar only observing.

Advantages:

- Keeps capital logic close to trading data.
- Can iterate faster inside Torghut.
- Avoids more Jangar read-model complexity.

Disadvantages:

- Leaves Jangar unable to gate dispatch, rollout, and merge readiness on settled proof.
- Splits operational evidence from capital evidence.
- Repeats the current cross-plane drift when a Jangar-controlled runtime failure blocks a Torghut repair.

Decision: Torghut needs the board, but it should consume Jangar-settled packets.

### Option C: Jangar Proof Settlement Broker With Torghut Repair Packet Gates

Make Jangar the typed settlement broker for runtime proof and require Torghut repair work to cite broker packet IDs.

Advantages:

- Turns cluster, source, database, and Torghut route evidence into one auditable unit.
- Keeps broad serving health separate from material action admission.
- Allows bounded repair while keeping normal dispatch and capital closed.
- Gives engineer and deployer stages concrete acceptance gates.
- Produces durable audit artifacts instead of raw event interpretation.

Disadvantages:

- Adds a new reducer and route payload to an already dense status surface.
- Requires stable failure fingerprints and careful freshness windows.
- Holds actions longer until packets are settled.

Decision: select Option C.

## Architecture

### ProofSettlementBroker

Jangar publishes one broker payload per namespace and status generation.

```text
proof_settlement_broker
  schema_version
  broker_id
  namespace
  generated_at
  fresh_until
  cluster_receipts
  data_receipts
  runtime_contract_receipts
  proof_packets
  action_class_verdicts
  next_repair_queue
  rollback_target
```

Cluster receipts come from pods, jobs, CronJobs, events, rollout health, controller heartbeats, watch reliability, and
AgentRun ingestion state. Data receipts come from Jangar migration consistency, Torghut `/db-check`, Torghut typed
quant health, market-context health, TCA summaries, and profitability proof floor. Runtime contract receipts come from
accepted Jangar/Torghut contract fields that must exist before action widening.

### Proof Packet

Each unsettled condition becomes a packet:

```text
proof_packet
  packet_id
  failure_family
  failure_fingerprint
  owner_surface
  observed_at
  first_seen_at
  severity
  consumer_action_classes
  current_receipts
  missing_receipts
  stale_receipts
  contradiction_refs
  settlement_state
  repair_budget
  required_success_receipt
  rollback_target
```

Settlement states:

- `active_blocker`: still blocks one or more action classes.
- `bounded_repair_allowed`: may run one repair action under the packet budget.
- `superseded_audit`: retained failure exists, but a later fresh receipt proves it is no longer active.
- `settled`: required success receipt exists and is fresh.
- `expired`: the packet was not repaired inside its freshness window and must be reissued.
- `contradicted`: receipts disagree and all widening is blocked.

### Mandatory Initial Packets

Engineer stage must implement these first:

- `agentrun_retained_failure`: old failed pods/jobs with later successful runs or no successor.
- `runner_configmap_mount_gap`: Job created but expected input/spec ConfigMap missing at pod mount time.
- `controller_readiness_brownout`: readiness probe timeouts on controller or agents pods.
- `schedule_placement_pressure`: FailedScheduling caused by node affinity or taint pressure.
- `empirical_jobs_degraded`: dependency quorum block from stale or degraded empirical jobs.
- `scoped_quant_missing_stages`: account/window quant health with no pipeline stages or empty latest store.
- `market_context_stale`: stale market-context domains that affect hypothesis readiness.
- `execution_tca_route_incomplete`: blocked or missing route symbols in the active universe.
- `alpha_promotion_empty`: zero promotion-eligible hypotheses or rollback-required hypotheses.

### Action Class Gates

The broker feeds material action verdicts:

- `serve_readonly`: allowed when database and route observation receipts are fresh, even if packets remain open.
- `torghut_observe`: allowed when Torghut typed status can be read and schema is current.
- `dispatch_repair`: allowed only for one `bounded_repair_allowed` packet with a declared success receipt.
- `dispatch_normal`: held until all mandatory packets for the namespace are `settled` or `superseded_audit`.
- `deploy_widen` and `merge_ready`: held while source rollout truth, controller readiness, runtime contract, or
  ConfigMap-to-Job packet is active.
- `paper_canary`: held until scoped quant, market context, route TCA, and alpha readiness packets are settled.
- `live_micro_canary` and `live_scale`: blocked until Torghut capital state leaves zero notional through companion
  profit repair receipts.

## Implementation Scope

Engineer stage should add:

- `services/jangar/src/server/control-plane-proof-settlement-broker.ts`.
- Unit tests that build packets from synthetic cluster/data receipts.
- A route payload extension in `control-plane-status.ts`.
- Material-action integration that consumes packet action verdicts.
- Torghut typed status adapters that normalize `/db-check`, quant health, proof floor, TCA, and route-reacquisition
  fields into data receipts.
- A retained-failure classifier that fingerprints pods/jobs by owner labels, schedule, stage, attempt, reason, and
  latest successor receipt.

Do not mutate Kubernetes resources as part of the broker. Cleanup and reruns remain deployer/repair actions gated by
packets.

## Validation Gates

Required local validation:

- `bunx oxfmt --check docs/agents/designs/165-jangar-proof-settlement-broker-and-profit-repair-packet-gates-2026-05-07.md docs/torghut/design-system/v6/169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md docs/torghut/design-system/v6/index.md`
- Targeted Jangar unit tests for broker reducers and material-action integration.
- Targeted Torghut tests for packet consumption and route-reacquisition status.

Required deployer validation after implementation:

- Read `/api/agents/control-plane/status?namespace=agents` and verify `proof_settlement_broker.generated_at` is fresh.
- Confirm at least the nine mandatory packet families appear with deterministic packet IDs.
- Confirm `dispatch_repair` names a packet and `dispatch_normal`, `paper_canary`, and live capital remain held while
  scoped quant, market context, route TCA, or alpha readiness packets are unsettled.
- Confirm a successful repair transitions one packet from `active_blocker` to `settled` or `superseded_audit` without
  widening unrelated action classes.

## Rollout

Roll out in four rings:

1. **Shadow**: emit broker payload only. Compare broker packet decisions with existing material action verdicts for 24
   hours.
2. **Repair-gated**: allow `dispatch_repair` only when a packet says `bounded_repair_allowed`; keep normal dispatch and
   capital unchanged.
3. **Widening gate**: make `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` consume broker verdicts.
4. **Capital gate**: require Torghut route-reacquisition and profit repair receipts before paper or live capital
   expansion.

## Rollback

Rollback is a feature flag and a data contract retreat, not a database rollback:

- Disable broker enforcement and keep the broker in observe-only mode.
- Keep existing material action verdicts as the fallback admission surface.
- Preserve emitted packets as audit artifacts; do not delete them.
- If packet generation causes route latency or payload-size issues, cap packet count by severity and emit a
  `packet_truncated=true` warning while retaining all hard blockers.

## Risks

- Packet IDs can churn if fingerprints include unstable pod names. Use owner refs, labels, reason, stage, and schedule
  before pod UID.
- The broker can become another broad status payload if packet ownership is vague. Every packet must name one owner
  surface and one success receipt.
- Direct database reads may remain unavailable to agent workers. Typed route projections must stay sufficient for
  least-privilege validation.
- If Torghut repair packets are treated as permission to trade, the architecture fails. Packets authorize repair, not
  capital widening.

## Handoff To Engineer

Implement the broker as a pure read model first. Use current reducers and typed routes as inputs. The first production
test should prove this case: Jangar deployment and database are healthy, but scoped quant health is empty and Torghut
proof floor is repair-only; the broker emits unsettled packets and material action keeps normal dispatch and capital
closed.

Acceptance gates:

- Deterministic packet IDs for the nine mandatory families.
- No Kubernetes or database mutation from broker generation.
- Packet freshness and action-class verdicts present in `/api/agents/control-plane/status`.
- Regression tests for retained failed jobs, missing ConfigMaps, scoped quant empty store, market-context staleness,
  and route TCA incompleteness.

## Handoff To Deployer

Deploy in observe-only mode first. Capture the first broker payload, compare packet counts against the agents namespace
pod/job summaries and Torghut `/trading/health`, then enable repair-gated mode only after the packet list is stable
across two status refreshes. Do not enable paper or live capital widening until Torghut companion receipts prove route
reacquisition, context freshness, scoped quant stages, and alpha promotion readiness.
