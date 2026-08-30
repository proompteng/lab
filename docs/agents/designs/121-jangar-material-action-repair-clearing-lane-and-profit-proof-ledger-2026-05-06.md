# 121. Jangar Material Action Repair Clearing Lane And Profit Proof Ledger (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar material-action verdicts, controller-ingestion proof repair, empirical-proof renewal admission, Torghut
capital unlocks, rollout safety, and cross-swarm handoff gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/125-torghut-profit-priced-evidence-renewal-and-capital-reentry-ledger-2026-05-06.md`

Extends:

- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md`
- `118-jangar-repair-admission-governor-and-profit-renewal-bids-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting a **material action repair clearing lane** as the next Jangar control-plane architecture step.

The previous accepted contract gives Jangar one final verdict for each material action. That is necessary, but it is
not sufficient. The live state on `2026-05-06T15:08Z` shows a healthier control plane that still has no disciplined way
to decide which repair to spend on first. Jangar serving is available, Argo reports `agents` and `jangar` `Synced` and
`Healthy`, the agents rollout is healthy, watches are healthy, and the Jangar database projection is current. At the
same time, material receipts still downgrade normal dispatch because controller ingestion is not an authoritative
process witness, and Torghut capital remains blocked or held because empirical proof is stale.

The selected design turns final action verdicts into a bounded repair market. Jangar emits repair-clearing items for
the exact evidence debt that blocks material action, ranks those items by action class and downstream value, and admits
only the repair work that can retire a named blocker inside a short proof budget. Torghut contributes expected profit
unlock and hypothesis priority; Jangar owns admission, sequencing, safety limits, and rollback.

The tradeoff is deliberate friction. This design will slow broad repair dispatch until each repair has a blocker,
budget, owner, expiry, and acceptance gate. I accept that. The six-month risk is not that Jangar lacks enough
background workers; it is that stale proof, controller witness gaps, and capital blockers accumulate into an unpriced
queue that either stays stuck or gets cleared by broad, unsafe dispatch. The clearing lane makes the queue explicit and
lets the system repair the smallest thing that reopens the highest-value safe action.

## Runtime Objective And Success Metrics

The runtime objective is to improve, maintain, and innovate the Jangar control plane while increasing Torghut
profitability. For this design, success is concrete:

- Jangar reduces failure modes by making each material-action blocker produce at most one active repair-clearing item.
- Rollout behavior is safer because normal dispatch, deploy widening, merge readiness, paper canary, and live capital
  can only widen after the final verdict and its repair-clearing record agree.
- Torghut profitability improves because stale empirical work is renewed in profit-ranked order instead of by manual
  guesswork or all-lanes refresh.
- Engineer and deployer stages can validate the design with status payload fixtures, local tests, and post-rollout
  service evidence.

## Evidence Snapshot

All evidence in this section was collected read-only. I did not mutate Kubernetes resources, database records, broker
state, trading flags, GitHub records, or Argo applications.

### Cluster And Rollout Evidence

- The runtime Kubernetes identity was `system:serviceaccount:agents:agents-sa`.
- The workspace had no current kube context, so I created the local `in-cluster` context from the mounted
  service-account token and CA before checking the cluster.
- `deployment/jangar` was `1/1` with image `registry.ide-newton.ts.net/lab/jangar:000d3b97`, and
  `/ready` returned HTTP `200`.
- `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, and both deployments were on the
  `000d3b97` release family.
- Argo CD reported `agents` and `jangar` as `Synced` and `Healthy` at revision
  `c61316511cafdea2315d4beea145b3b489c6209a`; `torghut` was `OutOfSync` but `Healthy`.
- Agents events showed the current scheduled discover, plan, implement, and verify jobs completing, while the retained
  pod/job history still included older failed plan and verify attempts. Recent readiness probe timeouts appeared during
  rollout replacement on `agents` and `agents-controllers`, then recovered.
- The service account cannot list `statefulsets.apps` in `jangar`, `agents`, or `torghut`. That access limit is useful
  evidence: the repair lane must work from service-owned health projections and allowed rollout reads, not privileged
  cluster assumptions.

### Database, Schema, And Data Evidence

- Jangar status reported `database.configured=true`, `database.connected=true`, `database.status=healthy`, and
  Kysely migration consistency at `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and
  `unexpected_count=0`.
- The latest registered and applied Jangar migration was
  `20260505_torghut_quant_pipeline_health_window_index`.
- Direct secret listing in `jangar` and `torghut`, direct CNPG cluster listing, and service-proxy reads were forbidden
  for this service account. I therefore used service-owned status routes as the database/data evidence surface.
- Torghut `/db-check` returned HTTP `200`, Alembic head `0029_whitepaper_embedding_dimension_4096`, one expected head,
  one current head, `schema_graph_lineage_ready=true`, and only known historical migration parent-fork warnings.
- Torghut `/trading/status` reported `last_decision_at=2026-05-04T17:25:57.901670Z`, which is old relative to the
  `2026-05-06T15:08Z` sample and reinforces that capital reentry needs fresh measured proof.
- Torghut empirical jobs were truthful but stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`,
  and `janus_hgrm_reward` were created on `2026-03-21T09:03:22Z`, tied to candidate `intraday_tsmom_v1@prod` and
  dataset `torghut-full-day-20260318-884bec35`.

### Control-Plane And Trading Evidence

- Jangar `/api/agents/control-plane/status?namespace=agents` reported dependency quorum `allow` for global control
  dependencies, rollout health `healthy`, execution trust `healthy`, and watch reliability `healthy` with `3` streams,
  `4642` events, `0` errors, and `2` restarts in the sampled window.
- The same Jangar status payload also showed `agentrun_ingestion.status=unknown` with message
  `agents controller not started` from the serving process perspective, while controller health was derived from the
  healthy `agents-controllers` rollout.
- Controller witness quorum therefore allowed bounded repair only until a fresh controller-ingestion witness is current.
  Material action receipts carried negative refs such as `controller-witness`, `empirical_jobs:endpoint:unknown`, and
  `witness:agentrun_ingestion`.
- Jangar empirical services reported forecast and lean disabled or degraded from missing configured endpoints, and
  jobs disabled as a Jangar authority. Paper canary remained held and live canary/scale remained blocked.
- Torghut `/healthz` returned HTTP `200`, while `/trading/health` returned HTTP `503` with `status=degraded`.
- Torghut live submission was blocked by `simple_submit_disabled`, `capital_stage=shadow`,
  `configured_live_promotion=false`, and `promotion_eligible_total=0`.
- Torghut hypotheses totalled `3`: one blocked, two shadow, zero promotion eligible, and three rollback required.
  The dependency quorum visible to hypotheses blocked on `empirical_jobs_degraded`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `753` lines and composes controller health, database status,
  rollout health, watch reliability, workflow freshness, empirical services, leases, action clocks, negative evidence,
  runtime admission, and controller witness receipts.
- `services/jangar/src/server/control-plane-controller-witness.ts` is `423` lines and already models
  `controller_ingestion_unknown` and `controller_ingestion_stalled` as material-action downgrades.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and maps stale empirical jobs,
  controller-ingestion gaps, rollout ambiguity, data freshness, and workflow failures into action SLO budgets.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and already translates empirical job debt
  into repair actions such as `refresh Torghut empirical job proof`.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains `2883` lines and owns the high-risk runtime
  path for schedules, runner ConfigMaps, CronJobs, workspace state, PVC lifecycle, requirements, freezes, and swarm
  admission.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already combines dependency quorum,
  empirical readiness, typed quant health, hypothesis state, and live submission toggles.
- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and already tracks truthfulness, freshness, candidate
  ids, dataset refs, artifact refs, and promotion authority eligibility.
- `services/torghut/app/trading/hypotheses.py` is `732` lines and already represents hypothesis state, capital stage,
  promotion eligibility, rollback requirement, required feature sets, and dependency capabilities.

## Problem

Jangar has accumulated strong diagnostic and verdict surfaces. It still lacks a first-class repair scheduler that
turns those verdicts into minimal, profit-aware, bounded repair work.

Without that lane, the system has three bad choices:

1. leave blocked actions blocked even when a small repair would clear them;
2. dispatch broad repair work without knowing which material action it unlocks;
3. let downstream systems decide their own repair order based on local value, which breaks Jangar authority.

The current evidence contains both classes of debt. Controller ingestion is unknown from one status perspective even
though the controller rollout is healthy. Torghut empirical proof is stale and capital is shadow-only even though the
service is alive, schema-current, and connected to its dependencies. These are not fatal serving outages. They are
repairable blockers that need a queue, budget, and settlement record.

## Alternatives Considered

### Option A: Keep The Verdict Arbiter As The Only New Surface

The engineer stage implements final material-action verdicts, and humans use the verdict reasons to decide follow-up
repair work.

Pros:

- Minimal new architecture.
- Clearer authority than the current partial surfaces.
- Avoids adding another queue or schema.

Cons:

- Leaves repair ordering manual.
- Does not prevent duplicate repair attempts for the same blocker.
- Does not connect Torghut profit value to Jangar repair admission.
- Does not produce a durable audit record for why a repair was worth spending capacity.

Decision: reject as incomplete. Verdicts say what is allowed; they do not decide what to repair first.

### Option B: Let Torghut Own Empirical Repair Scheduling

Torghut refreshes empirical jobs and proof artifacts in its own profitability order, then reports new readiness to
Jangar.

Pros:

- Keeps trading semantics local.
- Fast path for quant iteration.
- Lets Torghut optimize for hypothesis value and market timing.

Cons:

- Bypasses Jangar admission for repair dispatch.
- Does not address controller-ingestion witness debt or rollout safety.
- Can renew proof that still cannot unlock a Jangar material action.
- Recreates local capital authority under a different name.

Decision: reject as authority. Torghut should propose profit value; Jangar should admit repair work.

### Option C: Material Action Repair Clearing Lane

Jangar consumes final verdicts, negative evidence, controller witness state, empirical services, and Torghut profit
bids, then emits a bounded clearing item for each actionable blocker. The lane admits a small number of repair runs,
settles whether the blocker cleared, and exposes the result to deployer and Torghut consumers.

Pros:

- Keeps Jangar as the material-action authority.
- Converts blockers into testable work units with budgets and expiry.
- Reduces duplicate repairs and stale queue churn.
- Lets Torghut profitability influence priority without owning dispatch.
- Gives deployers a clean rollback point: stop the clearing lane, not the whole control plane.

Cons:

- Adds a projection and queue-like status surface.
- Requires careful deduplication so repair items do not become another noisy backlog.
- Can over-prioritize trading repairs unless action-class budgets are explicit.

Decision: select Option C.

## Architecture

Jangar adds a `material_action_repair_clearing_epoch` projection.

```text
material_action_repair_clearing_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  producer_revision
  verdict_epoch_ref
  dependency_quorum_ref
  controller_witness_ref
  negative_evidence_router_ref
  empirical_services_ref
  torghut_profit_bid_refs
  active_item_count
  admitted_item_count
  held_item_count
  blocked_item_count
  items
```

Each repair item is small and evidence-bound.

```text
material_action_repair_clearing_item
  item_id
  epoch_id
  action_class                      # dispatch_normal, merge_ready, paper_canary, live_micro_canary, live_scale
  blocker_code                      # controller_ingestion_unknown, empirical_jobs_stale, quant_latest_store_empty
  blocker_evidence_refs
  repair_kind                       # publish_controller_ingestion_witness, renew_empirical_job, refresh_quant_store
  owner_surface                     # jangar, torghut, shared
  requested_by                      # verdict, torghut_profit_bid, deployer
  decision                          # admit, hold, block, settled, expired
  admission_reason_codes
  max_dispatches
  max_runtime_seconds
  max_artifact_cost_usd
  max_notional
  expected_unlock_action_classes
  expected_profit_unlock_bps
  expected_profit_unlock_confidence
  expires_at
  settlement_ref
  rollback_target
```

The clearing lane is not a general task queue. It only admits work that can name:

- the material action currently held or blocked;
- the exact blocker to retire;
- the smallest validation command or runtime probe that proves repair;
- the maximum dispatch and runtime budget;
- the expected downstream value when the repair succeeds.

## Repair Admission Rules

1. `serve_readonly` repair is never admitted through this lane unless serving is degraded; ordinary serving remains
   outside trading profit priority.
2. `dispatch_repair` may admit one active controller-ingestion or transport repair per namespace when the controller
   witness quorum is `repair_only`.
3. `dispatch_normal` cannot admit broad workflow work while controller ingestion is unknown; it can only admit the
   witness repair that clears the unknown.
4. `merge_ready` repair cannot be greener than the final material-action verdict. It can admit source/schema or proof
   repair only when the blocker is directly cited by the final verdict.
5. `paper_canary` repair can admit Torghut empirical renewals only when the companion profit bid names a hypothesis,
   account, window, candidate, dataset, and expected post-cost threshold.
6. `live_micro_canary` and `live_scale` repair remain blocked until paper settlement exists and the material-action
   verdict allows the lower rung.
7. A stale or missing repair settlement expires the item and keeps the material action at its existing verdict.

## Jangar Repair Classes

### Controller-Ingestion Witness Repair

The current Jangar sample has a split: rollout-derived controller health is healthy, but AgentRun ingestion is unknown
from the serving process perspective. The repair item is:

- `repair_kind=publish_controller_ingestion_witness`;
- `action_class=dispatch_normal`;
- `max_dispatches=1`;
- `max_runtime_seconds=1200`;
- acceptance gate: status shows a fresh controller-process ingestion witness or heartbeat-backed ingestion witness;
- rollback: keep dispatch normal at `repair_only` and leave serving/read-only paths unaffected.

### Empirical Job Renewal Repair

The current Torghut sample has stale empirical jobs from `2026-03-21`. The repair item is:

- `repair_kind=renew_empirical_job`;
- `action_class=paper_canary`;
- one item per job type and candidate;
- admission requires a Torghut profit bid and a fresh final Jangar verdict that is no worse than `hold`;
- acceptance gate: Torghut reports the renewed job as truthful, non-stale, and promotion-authority eligible;
- rollback: expire the item and keep paper/live capital in shadow.

### Quant Latest-Store Repair

The prior verdict stack treats empty typed quant health as a capital blocker. The repair item is:

- `repair_kind=refresh_quant_store`;
- `action_class=paper_canary`;
- admission requires that empirical proof is no longer stale or is being renewed in the same epoch;
- acceptance gate: typed quant health for the account/window has nonzero latest metrics and a fresh update time;
- rollback: do not promote capital and keep the quant repair item visible as expired or blocked.

## Implementation Scope

Engineer stage:

1. Add `services/jangar/src/server/control-plane-repair-clearing.ts` as a pure reducer.
2. Feed it from the material-action verdict epoch, controller witness quorum, negative evidence router, empirical
   services, and Torghut profit bids.
3. Project `material_action_repair_clearing_epoch` in `/api/agents/control-plane/status`.
4. Add a small Torghut profit-bid input contract, initially read from Torghut status rather than a new database table.
5. Add tests proving one controller-ingestion blocker produces one repair item, stale empirical jobs produce one item
   per named job only when a profit bid exists, and expired settlements fail closed.
6. Keep `supporting-primitives-controller.ts` out of the reducer; dispatch integration should call the reducer output,
   not embed the logic in the large controller module.

Deployer stage:

1. Ship the projection in `shadow` mode first.
2. Verify that the current state produces one controller-ingestion witness repair item and empirical renewal items for
   stale Torghut jobs, with no live-capital repair admissions.
3. Enable `dispatch_repair` enforcement for controller witness repair before enabling Torghut empirical repair
   admission.
4. Keep live capital enforcement disabled until paper settlement exists and the companion Torghut gates pass.

## Validation Gates

Local validation before merge:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-repair-clearing.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar check:module-sizes`
- `bun run --cwd services/jangar lint`

Runtime validation after rollout:

- `/api/agents/control-plane/status?namespace=agents` includes one `material_action_repair_clearing_epoch`.
- In the current split-controller sample, `dispatch_normal` has a bounded controller-ingestion witness repair item and
  no broad normal-dispatch admission.
- In the current stale Torghut proof sample, paper canary repair items cite the stale empirical job names and Torghut
  profit bids.
- No `live_micro_canary` or `live_scale` item is admitted until paper settlement is present.
- Clearing items expire if their settlement is not refreshed before `expires_at`.

## Rollout Plan

1. Shadow emit clearing epochs in status routes.
2. Add UI and deployer readouts that label clearing items as repair admission, not final action authority.
3. Enforce controller-ingestion witness repair admission for `dispatch_repair`.
4. Enforce empirical renewal admission for `paper_canary` only after Torghut emits profit bids and local tests pass.
5. Enforce live-capital repair admission only after paper settlement demonstrates the measured profit and slippage
   thresholds from the companion contract.

## Rollback Plan

- If clearing epoch generation fails, keep material-action verdicts and disable the clearing projection.
- If repair items churn, disable admission enforcement and keep the shadow projection for diagnosis.
- If a repair item admits too much work, set its action class to `hold` by configuration and revert the reducer PR.
- If Torghut profit bids are malformed, ignore those bids and keep capital in shadow; do not mutate empirical job rows.
- Any additive persistence can remain in place until a later cleanup migration; incident rollback should avoid schema
  drops.

## Risks

- A profit-ranked lane can starve non-trading repairs if action-class budgets are not explicit. The first
  implementation must reserve controller-ingestion witness repair capacity.
- The reducer can become noisy if every negative reason becomes a repair item. Only blockers cited by the final
  material-action verdict are eligible.
- Torghut profit bids can overstate expected value. Jangar should treat them as priority hints, not authority.
- Shadow-mode success can hide missing consumers. Deployer validation must prove the intended consumers read the
  clearing lane before enforcement.

## Handoff

Engineer acceptance gates:

- A fixture with `controller_ingestion_unknown` and healthy rollout creates exactly one
  `publish_controller_ingestion_witness` item for `dispatch_normal`.
- A fixture with four stale empirical jobs and three Torghut hypotheses creates empirical renewal items only for jobs
  attached to active profit bids.
- A fixture with missing or expired settlement keeps the original material-action verdict unchanged.
- A fixture with live capital blockers never admits `live_micro_canary` or `live_scale` repair before paper settlement.
- Status tests prove the clearing epoch cites the verdict epoch and does not replace it.

Deployer acceptance gates:

- Shadow rollout shows stable clearing epochs for one full Jangar scheduling cycle.
- Controller witness repair enforcement is enabled before Torghut empirical repair enforcement.
- Paper canary repair remains shadow-only until Torghut empirical jobs are non-stale and quant latest-store evidence is
  present.
- Rollback instructions name the exact enforcement flag or revert PR used to disable the clearing lane.
