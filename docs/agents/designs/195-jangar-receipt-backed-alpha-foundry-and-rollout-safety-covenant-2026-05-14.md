# 195. Jangar Receipt-Backed Alpha Foundry And Rollout Safety Covenant (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane repair admission, duplicate/no-delta denial, rollout safety, Torghut alpha evidence
foundry consumption, validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md`

Extends:

- `193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
- `194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`
- `docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`
- `192-jangar-alpha-readiness-repair-escrow-and-runner-admission-2026-05-13.md`
- `192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md`
- `188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md`
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

## Decision

I am selecting a **receipt-backed alpha foundry covenant** for Jangar.

Jangar is serving, but it still needs a tighter rule for Torghut alpha repair. On 2026-05-14, `deployment/jangar` was
`1/1`, `agents` was `1/1`, `agents-controllers` was `2/2`, database status was healthy with `29/29` Kysely migrations
applied, controller heartbeats were fresh, and rollout health was green for the configured agents deployments. At the
same time, the agents namespace retained many recent Error and OOMKilled AgentRun pods, and Torghut consumer evidence
reported `accepted_routeable_candidate_count=0`, `decision=repair`, `route_repair_value=14`, and a large blocker set.

The live Torghut revenue queue is clear: `/trading/revenue-repair` says the top work is `repair_alpha_readiness` for
`routeable_candidate_count`, with max notional `0`. Jangar should admit one bounded zero-notional alpha repair only
when Torghut provides a current foundry receipt target, and it should deny duplicate/no-delta work until new evidence
appears. The control-plane improvement is resilience: fewer repeated repair runs, safer rollout claims, and cleaner
handoff evidence for engineer and deployer stages.

The tradeoff is stricter launch denial. Some jobs that used to run opportunistically will be held until they can name
the foundry receipt they intend to settle. I accept that because failed verify and no-delta repair runs are more
expensive than waiting for a precise receipt contract.

## Governing Runtime Requirements

This contract follows the active validation requirements:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Jangar value-gate mapping:

- `failed_agentrun_rate`: deny duplicate/no-delta alpha repairs and require terminal receipt settlement.
- `pr_to_rollout_latency`: require deployer handoff to cite source, image, Argo, workload, service, and Torghut foundry
  receipt evidence before claiming rollout ready.
- `ready_status_truth`: keep serving readiness green while material Torghut paper/live actions remain held.
- `manual_intervention_count`: select one alpha foundry receipt target instead of forcing operators to triage a wide
  blocker list.
- `handoff_evidence_quality`: every accepted repair must name the foundry id, receipt id, validation command, and
  rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: the selected receipt must target a measurable routeable-candidate delta.
- `post_cost_daily_net_pnl`: the receipt must carry post-cost proof or a denial reason.
- `zero_notional_or_stale_evidence_rate`: stale foundry receipts hold repair admission.
- `fill_tca_or_slippage_quality`: TCA guardrails remain required before routeable candidate movement.
- `capital_gate_safety`: nonzero notional, paper/live enablement, or missing rollback target blocks settlement.

## Current Evidence

All evidence was collected read-only on 2026-05-14.

### Cluster And Rollout

- Jangar namespace: `deployment/jangar` was `1/1`, `deployment/jangar-alloy` was `1/1`, `jangar-db-1` was running,
  and the active Jangar pod used image `registry.ide-newton.ts.net/lab/jangar:202dcaf1`.
- Jangar recent events showed a normal pod replacement and transient readiness probe failure during startup, then the
  new pod became ready.
- Agents namespace: `agents` was `1/1`, `agents-controllers` was `2/2`, and `agents-alloy` was `1/1`.
- The same namespace retained many recent completed and failed scheduled runs, including Error and OOMKilled pods in
  discover, plan, implement, and verify lanes. That is the current reliability pressure: launch fewer imprecise runs.
- Torghut namespace: active live and sim revisions were running, but whitepaper autoresearch profit-target pods had a
  long error tail. Torghut options catalog readiness was failing after a PostgreSQL deadlock in subscription-state
  upsert, while options enricher was ready.

### Runtime And Database

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, execution trust healthy, runtime proof
  cells healthy, and Torghut consumer evidence `current`.
- `GET /api/agents/control-plane/status?namespace=agents` reported database `healthy`, latency `11 ms`, and migration
  consistency healthy with `29` registered and `29` applied migrations through
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Controllers `agents-controller`, `supporting-controller`, and `orchestration-controller` were enabled, started, CRD
  ready, and had fresh heartbeat authority.
- Rollout health was healthy for `agents` and `agents-controllers`.
- Torghut consumer evidence reported serving revision `torghut-00371`, image digest
  `sha256:8d3a43bed9c6da942827c5e25f40fc88d1b0712a99a172831da222eebc820c4d`, build commit
  `8d84f9f5ce028214bfb5326e0791638bc35625f5`, route repair value `14`, routeability aggregate state `blocked`, and
  accepted routeable candidate count `0`.
- The same payload reported evidence-clock split across Torghut quant, Postgres TCA, hypothesis lineage, rollout,
  routeability acceptance, profit signal quorum, and capital gate.
- `paper_canary` was held and `live_micro_canary` plus `live_scale` were blocked with reasons including
  `hypothesis_not_promotion_eligible`, `feature_rows_missing`, `required_feature_set_unavailable`,
  `post_cost_expectancy_non_positive`, `execution_tca_stale`, `execution_tca_symbol_missing`,
  `routeability_acceptance_blocked`, `simple_submit_disabled`, and `max_notional_zero`.

## Problem

Jangar has enough status truth to know Torghut is not capital-ready. It does not yet have a small covenant that says
which zero-notional alpha repair is allowed, how it settles, and when a duplicate is denied.

Concrete failure modes:

1. A green Jangar or agents rollout can be mistaken for material authority while Torghut paper/live actions are still
   held or blocked.
2. The Torghut blocker list is wide enough that workers can dispatch repair runs that do not touch the live top queue
   item.
3. Repeated alpha repair runs can consume capacity without changing `routeable_candidate_count` or retiring a reason.
4. Source, image, service health, and Torghut receipt proof are collected manually in deployer handoff.
5. Options catalog and market-context failures can keep adding stale evidence pressure while unrelated repair runs are
   launched.

The control plane needs one rule: admit alpha repair only when the live revenue queue, foundry receipt, rollout proof,
and capital safety fields agree.

## Alternatives Considered

### Option A: Keep Cross-Plane Closure Board Only

Use doc 193's closure board and do not add a foundry-specific covenant.

Advantages:

- Avoids another status contract.
- Keeps Jangar action-class logic generic.
- Works for broad merge, deploy, and repair closures.

Disadvantages:

- Does not define settlement semantics for alpha evidence-window receipts.
- Does not deny duplicate/no-delta alpha repairs precisely.
- Leaves Torghut's top business blocker mixed with generic closure lots.

Decision: reject as sufficient. The closure board stays the parent contract, but alpha repair needs a tighter covenant.

### Option B: Freeze Torghut Repair Until All Action Budgets Are Green

Block every Torghut repair run until `paper_canary` is allowed.

Advantages:

- Very safe.
- Easy to explain during incidents.
- Prevents repair lanes from amplifying rollout or data-plane noise.

Disadvantages:

- Deadlocks the system because zero-notional alpha repair is needed to clear the paper canary blockers.
- Increases manual intervention.
- Does not improve routeable candidate count.

Decision: reject. Keep capital blocked, but keep bounded zero-notional repair open.

### Option C: Admit Any Dispatchable Torghut Repair Lot

Let Jangar run any dispatchable compacted repair lot with max notional zero.

Advantages:

- Maximizes repair throughput.
- Uses existing Torghut compacted lots.
- Can improve freshness or feature lineage quickly.

Disadvantages:

- Ignores the live revenue queue.
- Repeats no-delta work unless settlement is explicit.
- Makes failed AgentRun rate worse when the selected lot lacks a concrete after-receipt target.

Decision: reject as the primary rule.

### Option D: Receipt-Backed Alpha Foundry Covenant

Admit exactly one zero-notional alpha repair per account/window/top queue item when Torghut publishes a current foundry
receipt target. Settle, roll forward, or deny based on the receipt delta.

Advantages:

- Aligns Jangar runner capacity with the live Torghut revenue queue.
- Preserves serving readiness and capital safety separation.
- Reduces duplicate/no-delta AgentRun launches.
- Gives deployers one acceptance artifact for image, service, and Torghut evidence after rollout.

Disadvantages:

- Requires Jangar to consume a new Torghut field.
- Adds shadow comparison before enforcement.
- Can hold lower-priority work while alpha readiness remains first.

Decision: select Option D.

## Architecture

Jangar consumes `alpha_evidence_foundry` from Torghut's `/trading/revenue-repair` and `/trading/consumer-evidence`.
It builds a local covenant projection:

```text
alpha_foundry_covenant
  schema_version = jangar.alpha-foundry-covenant.v1
  covenant_id
  generated_at
  fresh_until
  namespace
  torghut_revenue_repair_ref
  torghut_consumer_evidence_ref
  foundry_id
  selected_queue_code
  selected_value_gate
  action_class = torghut_alpha_repair
  decision = allow_zero_notional_repair | hold | block
  selected_receipt_id
  selected_hypothesis_id
  dedupe_key
  required_output_receipt = torghut.alpha-evidence-window-receipt.v1
  validation_commands[]
  rollout_receipts[]
  no_delta_debt_refs[]
  max_notional = 0
  rollback_target
```

Admission is `allow_zero_notional_repair` only when:

1. Torghut revenue repair is current and its top queue item is `repair_alpha_readiness`.
2. The foundry is current and has at least one receipt with expected routeable candidate delta.
3. The selected receipt carries `max_notional=0` and `capital_rule=zero_notional_repair_only`.
4. Torghut consumer evidence is current and serving revision/image digest are present.
5. Jangar rollout health for `agents` and `agents-controllers` is healthy.
6. No active run owns the same account/window/hypothesis/reason-set dedupe key.
7. No open no-delta debt exists for the same receipt id unless the blocker set or post-cost evidence changed.
8. `paper_canary`, `live_micro_canary`, and `live_scale` remain held or blocked until independent Torghut proof-floor
   and routeability gates pass.

Settlement outcomes:

- `release_credit`: measured routeable candidate count increases and all capital fields remain zero.
- `roll_forward`: reason codes are preserved but the receipt names a smaller next blocker with fresh evidence.
- `burn_credit`: no measured delta and no smaller blocker; duplicate admission is denied until evidence changes.
- `hold`: receipt missing, stale, or incomplete.
- `block`: any notional drift, paper/live enablement, rollback drift, or source-serving mismatch.

## Failure-Mode Reduction

- **Failed AgentRun rate:** a duplicate/no-delta alpha repair is denied before a pod is launched.
- **Rollout false positives:** Jangar can be serving while material Torghut actions remain held; the covenant makes that
  explicit in the action decision.
- **Manual handoff gaps:** engineer and deployer stages cite the same foundry id, receipt id, image digest, and rollback
  target.
- **Capital safety:** capital classes stay blocked until Torghut proof floor, routeability acceptance, and post-cost
  proof independently pass.
- **Data-plane drift:** market-context, TCA, options catalog, and source-serving gaps remain guardrails instead of
  being hidden behind a green control-plane route.

## Implementation Scope

Engineer stage should add the first Jangar consumer after Torghut emits `alpha_evidence_foundry`:

- Add a pure reducer under the existing control-plane Torghut consumer evidence code path.
- Parse `alpha_evidence_foundry` from Torghut payloads.
- Emit `alpha_foundry_covenant` from the control-plane status route in shadow mode.
- Add tests for allow, hold, block, duplicate, no-delta, stale foundry, nonzero notional, and missing rollout proof.
- Do not change paper/live action enforcement in the first slice.

Candidate validation commands:

```bash
bun run --filter jangar test -- control-plane-torghut-consumer-evidence
bun run --filter jangar test -- control-plane-ready-truth
bun run --filter jangar lint
```

Deployer stage should validate after the Jangar PR and image promotion:

```bash
kubectl -n jangar rollout status deploy/jangar
kubectl -n agents rollout status deploy/agents
kubectl -n agents rollout status deploy/agents-controllers
curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.torghut_consumer_evidence.status'
curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.alpha_foundry_covenant'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.alpha_evidence_foundry'
```

## Rollout

1. Ship Torghut foundry first.
2. Ship Jangar consumer in shadow mode; compare covenant decision with current Torghut action budgets for at least one
   live refresh.
3. Add progress-comment and NATS handoff evidence for the first foundry-backed repair run.
4. Enforce duplicate/no-delta denial only for `torghut_alpha_repair` after a live service check proves the covenant
   field is present.
5. Keep paper/live capital authority unchanged until Torghut proof-floor and routeability gates leave repair-only.

## Rollback

Rollback is to ignore `alpha_evidence_foundry` and fall back to the existing cross-plane closure board and
alpha-readiness strike ledger. If Jangar parsing fails after rollout, revert the Jangar consumer PR, promote the
previous image through GitOps, and verify:

- `GET /ready` remains `status=ok`;
- control-plane status still reports database, controllers, and rollout health;
- Torghut consumer evidence is current;
- paper/live Torghut action classes remain held or blocked;
- no active duplicate/no-delta denial is enforced from a stale foundry field.

## Risks

- Torghut may emit a foundry object before all receipt fields are stable. Mitigation: shadow mode first and block
  enforcement on schema version.
- Denying duplicate work can hold useful exploratory repairs. Mitigation: allow a new run when the blocker set,
  receipt id, or post-cost proof changes.
- Control-plane status can become too large. Mitigation: emit compact covenant fields and keep detailed receipt data in
  Torghut.
- A green Jangar route may still coexist with Torghut options catalog or market-context failures. Mitigation: require
  deployer handoff to cite both Jangar route status and Torghut foundry guardrails.

## Handoff

Engineer next action: after Torghut emits `alpha_evidence_foundry`, add the Jangar shadow reducer and tests so
`alpha_foundry_covenant.decision` selects one zero-notional alpha repair or denies it with a specific reason.

Deployer next action: after the Jangar consumer merges, prove live status exposes the covenant, then keep capital
classes held until Torghut receipt settlement moves `routeable_candidate_count` above zero.

Smallest blocker preventing revenue impact today: Jangar cannot yet require a settled
`torghut.alpha-evidence-window-receipt.v1`, so repeated alpha repair work can still be admitted without proving a
routeable-candidate delta.
