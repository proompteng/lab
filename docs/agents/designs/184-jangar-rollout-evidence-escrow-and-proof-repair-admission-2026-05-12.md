# 184. Jangar Rollout-Evidence Escrow And Proof-Repair Admission (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Gideon Park, Torghut Traders Architecture Lead
Scope: Jangar control-plane resilience, rollout safety, proof repair admission, Torghut clearinghouse consumption,
failed-run reduction, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/188-torghut-route-evidence-clearinghouse-and-execution-freshness-market-2026-05-12.md`

Extends:

- `183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- `182-jangar-routeability-cutover-backpressure-and-proof-run-admission-2026-05-08.md`
- `181-jangar-proof-production-debt-and-routeability-admission-2026-05-08.md`
- `docs/torghut/design-system/v6/187-torghut-profit-window-custody-and-repair-value-market-2026-05-08.md`

## Decision

I am selecting **rollout-evidence escrow with proof-repair admission** as Jangar's companion control-plane contract for
the Torghut route-evidence clearinghouse.

Jangar is healthy enough to supervise work but not healthy enough to let stages infer action readiness from their
local success. On May 12, `agents`, `jangar`, `kafka`, `nats`, and the symphony applications were `Synced/Healthy`.
`agents-controllers` was `2/2`, and Jangar DB heartbeats reported the agents, orchestration, supporting, and workflow
runtime controllers as healthy and enabled at `2026-05-12T16:31:38Z`. Jangar `/ready` returned `status=ok` and the
serving pod was leader-elected.

The same read showed why Jangar still needs escrow. Jangar `/ready` reported `execution_trust.status=degraded`
because swarm freeze and stage staleness held discover, plan, implement, and verify. The agents namespace retained
failed schedule and market-context pods, including recent `BackoffLimitExceeded` events for AMZN and INTC fundamentals
and news jobs. Torghut was `Synced/Degraded`, `torghut-options` was `Synced/Progressing`, and four route-adjacent
workloads were stuck on missing image digests. Torghut itself was `healthz=ok` but `/readyz=degraded`, repair-only,
zero-notional, and missing a live routeability acceptance ledger.

The selected design makes Jangar hold action classes in a rollout-evidence escrow. Jangar may admit zero-notional
repair work only when the run cites a Torghut clearinghouse lot, a rollout evidence lot, one value gate, and the output
receipt it will produce. Jangar cannot upgrade routeability, paper, live, deploy widening, or merge readiness from pod
health, Argo sync, green CI, fresh quant metrics, or a completed AgentRun.

The tradeoff is stricter scheduling. Some runs that could start will wait for a lot reference and a receipt contract.
That is the right cost. The control plane's job is not to maximize launches; it is to reduce failed and irrelevant
runs while preserving capital safety and making rollout blockers explicit.

## Evidence Snapshot

All evidence was collected for assessment. Kubernetes and database inspection were read-only from the control-plane
perspective; no GitOps resources, Kubernetes resources, broker state, trading flags, or database records were
intentionally changed.

### Cluster And Control Plane

- In-cluster auth is `system:serviceaccount:agents:agents-sa`.
- Argo applications `agents`, `agents-ci`, `jangar`, `kafka`, `nats`, `symphony-jangar`, and `symphony-torghut` are
  `Synced/Healthy`.
- Argo reports `torghut` as `Synced/Degraded` and `torghut-options` as `Synced/Progressing`.
- `deployment/agents` is `1/1`, `deployment/agents-controllers` is `2/2`, and `deployment/jangar` is `1/1`.
- Jangar `/ready` returns `status=ok`, `leaderElection.isLeader=true`, and
  `orchestrationController.started=true`.
- Jangar `/ready` also reports `execution_trust.status=degraded` with stage staleness and swarm freeze reasons.
- Current failed route-adjacent Torghut pods are `torghut-ws`, `torghut-ws-options`, `torghut-ta-sim`, and
  `torghut-options-ta`, all due to missing registry digests.
- Agents namespace recent events include `BackoffLimitExceeded` for market-context fundamentals and news jobs for
  AMZN and INTC, plus successful current Torghut quant plan/implement schedule jobs.
- Agents namespace has many retained failed pods from prior schedules. That history should count as failure debt, not
  as a runtime outage by itself.

### Runtime And Torghut Evidence

- Torghut `/healthz` returns HTTP 200.
- Torghut `/readyz` returns `status=degraded`.
- Torghut dependencies show Postgres, ClickHouse, Alpaca broker, schema, universe, and latest quant evidence are not
  the immediate blockers.
- Torghut proof blockers are `simple_submit_disabled`, `profitability_proof_floor=repair_only`, and
  `capital_state=zero_notional`.
- `/trading/status` reports `routeable_candidate_count=0`, `paper_candidate_count=0`, three observe-only quorums,
  three zero-notional quorums, and `blocked_or_stale_evidence_count=20`.
- Torghut has not emitted a live `routeability_acceptance_ledger` in status, revenue repair, or consumer evidence.
- Torghut Postgres shows stale proof for paper/live admission: no trade decisions in the last day, newest TCA on
  `2026-05-08T02:38:30Z`, and newest execution creation on `2026-04-02T20:59:45Z`.
- Options catalog freshness is mixed: `2442749` contracts and fresh `last_seen_ts`, but all contracts lack
  `provider_updated_ts`, `1101383` lack close price, and `1206699` have zero open interest.

### Jangar Database

- Jangar schemas include `agents_control_plane`, `workflow_comms`, `memories`, and `torghut_control_plane`.
- `agents_control_plane.component_heartbeats` reports healthy enabled heartbeats for agents, orchestration,
  supporting, and workflow runtime controllers at `2026-05-12T16:31:38Z`.
- `agents_control_plane.resources_current` has about `5707` live rows with recent analyze/vacuum.
- `torghut_control_plane.quant_metrics_latest` has `4536` rows with newest `updated_at=2026-05-12T16:31:38Z`.
- `workflow_comms.agent_messages` has `21057` rows with newest `created_at=2026-05-12T16:31:30Z`.
- `memories.entries` has `1176` rows, but the repo helper for memory retrieval returned HTTP 500 during this run.

### Source And Test Surface

- `services/jangar/src/server/supporting-primitives-controller.ts` is `3327` lines and owns schedule generation,
  runtime admission, workspace lifecycle, and swarm stage reconciliation. Escrow logic should not become another large
  inline branch there.
- Existing Jangar control-plane modules provide cleaner homes for the reducer and projection:
  `control-plane-runtime-admission.ts`, `control-plane-material-action-verdict.ts`,
  `control-plane-negative-evidence-router.ts`, `control-plane-torghut-consumer-evidence.ts`,
  `control-plane-rollout-health.ts`, and `control-plane-status.ts`.
- The new test surface is the escrow invariant:
  - `ready=ok` cannot upgrade action classes while execution trust is degraded.
  - Argo `Synced` cannot upgrade deploy widening while required route images are unresolved.
  - A completed AgentRun cannot upgrade routeability without a Torghut clearinghouse accepted route claim.
  - Repair dispatch is allowed only when it cites a lot, value gate, and output receipt.

## Problem

Jangar currently has many useful signals but no escrow that decides which signal wins for a concrete action.

That creates five failure modes:

1. A schedule can launch because the controller is available while the swarm stage is stale.
2. A deploy step can point at Argo sync while route-adjacent images are missing from the registry.
3. A proof repair run can complete without retiring a Torghut clearinghouse lot.
4. A Torghut route claim can cite fresh quant latest rows while source clocks, TCA, or image proof are stale.
5. A merge or rollout claim can point at green local evidence while retained failure debt and Torghut capital holds
   still require backpressure.

Jangar needs a compact escrow receipt that carries the strongest applicable hold and the smallest admissible repair.

## Alternatives Considered

### Option A: Treat Current Controller Heartbeats As Enough

Use the healthy controller heartbeats and running deployments as the dispatch authority.

Advantages:

- Simple and available today.
- Aligns with the current healthy controller rows in Jangar DB.
- Keeps repair throughput high.

Disadvantages:

- Ignores execution-trust degradation from stage staleness.
- Ignores retained failed AgentRuns and market-context job failures.
- Does not connect dispatch to Torghut route-evidence lots.

Decision: reject. Controller heartbeat is a prerequisite, not an admission receipt.

### Option B: Let Torghut Block Capital And Let Jangar Run Broad Repair

Rely on Torghut proof floor for capital safety while Jangar continues launching broad repair jobs.

Advantages:

- Capital stays protected by Torghut.
- Jangar implementation surface stays smaller.
- Repairs can continue during zero-notional holds.

Disadvantages:

- Failed or irrelevant repair runs keep accumulating.
- Jangar cannot prove which value gate a run improves.
- Routeability repair and image repair stay separate human judgments.

Decision: reject as the architecture. It is a fallback posture, not a resilient control plane.

### Option C: Rollout-Evidence Escrow With Proof-Repair Admission

Create a versioned Jangar escrow receipt for each action class. The receipt cites controller witness, stage freshness,
retained failure debt, rollout image proof, Torghut clearinghouse lot, value gate, and allowed repair scope.

Advantages:

- Reduces failed and low-value dispatch by requiring lot-scoped repair.
- Makes missing image digests a first-class rollout hold.
- Preserves Torghut capital authority.
- Gives deployers one action-class packet instead of many local interpretations.
- Maps directly to `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`,
  `routeable_candidate_count`, and `capital_gate_safety`.

Disadvantages:

- Adds a reducer and status surface.
- Requires Jangar to consume Torghut clearinghouse packets.
- Slows broad dispatch until runs cite a lot and output receipt.

Decision: select Option C.

## Architecture

Jangar publishes `rollout_evidence_escrow`:

```text
rollout_evidence_escrow
  schema_version
  generated_at
  fresh_until
  namespace
  swarm_name
  stage
  action_class
  decision                  # allow | repair_only | hold | block
  allowed_scope
  max_dispatches
  max_runtime_seconds
  max_notional
  controller_witness_ref
  execution_trust_ref
  stage_freshness_ref
  retained_failure_debt_ref
  rollout_image_book_ref
  torghut_clearinghouse_ref
  torghut_route_claim_ref
  value_gate
  required_output_receipts[]
  forbidden_shortcuts[]
  hold_reasons[]
  rollback_target
```

Initial action classes:

- `serve_readonly`
- `proof_repair_dispatch`
- `image_promotion_repair`
- `market_context_repair`
- `route_evidence_claim`
- `paper_canary`
- `live_micro_canary`
- `deploy_widen`
- `merge_ready`

Escrow rules:

- `serve_readonly` may remain allowed while execution trust is degraded if Jangar serving is healthy.
- `proof_repair_dispatch` may be `repair_only` when it cites a Torghut clearinghouse lot, value gate, output receipt,
  runtime budget, and zero-notional scope.
- `image_promotion_repair` is allowed for missing digests, but cannot upgrade routeability by itself.
- `route_evidence_claim` is held until Torghut emits an accepted clearinghouse route claim.
- `paper_canary`, `live_micro_canary`, and capital-adjacent classes are held while Torghut proof floor is repair-only
  or submit is disabled.
- `deploy_widen` is held if required route-adjacent images are unresolved or retained failure debt exceeds the action
  budget.
- `merge_ready` may cite green CI only as one input; it still requires no unresolved escrow hold for the action class.
- A completed AgentRun cannot upgrade any class unless its output receipt matches the required output receipt.

## Implementation Scope

Engineer milestone 1: add the escrow reducer in observe mode.

- Inputs: controller witness, execution trust, stage freshness, retained failure debt, rollout health, Torghut
  clearinghouse packet, and current action class.
- Output: `rollout_evidence_escrow` in Jangar status/control-plane projection.
- Value gates: `zero_notional_or_stale_evidence_rate`, `capital_gate_safety`.

Engineer milestone 2: wire repair admission.

- Scheduler may launch proof repairs only when a lot, value gate, output receipt, and runtime budget are present.
- Image-promotion repair gets its own class and does not count as routeability.
- Value gates: `fill_tca_or_slippage_quality`, `routeable_candidate_count`,
  `zero_notional_or_stale_evidence_rate`.

Engineer milestone 3: enforce held action classes.

- Hold route evidence claims, paper canaries, live canaries, deploy widening, and merge-ready claims when escrow
  decision is `hold` or `block`.
- Keep zero-notional repairs available when they are lot-scoped.
- Value gates: `capital_gate_safety`, `post_cost_daily_net_pnl`.

Deployer milestone:

- Verify Jangar status emits escrow packets after rollout.
- Verify missing Torghut image digests appear as `hold:image_digest_unresolved`.
- Verify Torghut clearinghouse repair-only state keeps paper/live action classes held.

## Validation Gates

- `post_cost_daily_net_pnl`: Jangar cannot claim revenue impact until Torghut clearinghouse accepts a route and
  post-cost receipts exist.
- `routeable_candidate_count`: cannot increase from Jangar escrow or AgentRun completion alone.
- `zero_notional_or_stale_evidence_rate`: every repair dispatch must cite the stale lot it retires.
- `fill_tca_or_slippage_quality`: TCA repair runs are allowed only as zero-notional proof repair until Torghut accepts
  current fill quality.
- `capital_gate_safety`: paper/live/deploy-widening classes are held while Torghut is repair-only, submit is disabled,
  images are unresolved, or clearinghouse route claims are absent.

## Rollout

1. Publish escrow decisions in observe mode.
2. Compare escrow decisions with current Jangar readiness, retained failed pods, Argo health, and Torghut
   clearinghouse packets.
3. Enable repair-only admission for lot-scoped proof and image repair.
4. Enforce holds for route evidence claims, paper/live canaries, deploy widening, and merge-ready claims.
5. Promote enforcement only after one market session shows no incorrect repair holds and no capital-class false allow.

## Rollback

- Disable escrow enforcement and keep observe-only packets.
- Continue using Torghut proof floor and submit gate as the capital backstop.
- Hold all Torghut paper/live action classes if Jangar execution trust degrades or clearinghouse packets disappear.
- Do not treat a rollback as permission to run broad unscoped repair dispatch.

## Risks

- Escrow can become a second material-action verdict if naming is loose. Keep it as the action-class wrapper that cites
  existing receipts.
- Stage staleness may hold useful repairs. Allow only lot-scoped zero-notional repair through that condition.
- Missing image digests are operationally urgent but not sufficient for routeability. Keep image proof distinct from
  route proof.
- Memory helper failures reduce retrieval quality for agents. They should be recorded as control-plane repair lots,
  not as Torghut capital blockers.

## Handoff

Engineer:

- Implement escrow as a pure reducer and status projection before enforcing scheduler behavior.
- Add tests for healthy controller plus stale stage, Argo synced plus unresolved image, completed AgentRun plus missing
  output receipt, and Torghut repair-only plus paper/live hold.
- Do not let Jangar create or widen Torghut capital decisions.

Deployer:

- Verify escrow packets in live Jangar status before enforcement.
- Verify image digest holds and Torghut clearinghouse holds are visible and actionable.
- Keep all paper/live classes held until Torghut clearinghouse and capital gates explicitly settle.
