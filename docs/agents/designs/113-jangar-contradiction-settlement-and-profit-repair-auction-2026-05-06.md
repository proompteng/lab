# 113. Jangar Contradiction Settlement And Profit Repair Auction (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane contradiction settlement, material-action admission, rollout safety, Torghut proof repair,
and profit-oriented recovery prioritization.

Companion Torghut contract:

- `docs/torghut/design-system/v6/117-torghut-contradiction-priced-profit-repair-and-capital-readmission-2026-05-06.md`

Extends:

- `112-jangar-session-scoped-proof-settlement-and-stale-alert-netting-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`
- `110-jangar-gitops-convergence-escrow-and-promotion-evidence-ledger-2026-05-06.md`

## Decision

I am selecting a **contradiction settlement ledger with a profit repair auction** as the next Jangar control-plane
architecture step.

The current Jangar runtime is not failing in the old way. In the read-only sample at `2026-05-06T11:24Z`, Jangar was
serving, `deployment/jangar` was `1/1`, `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, the
Jangar database projection was healthy with `28/28` Kysely migrations applied, execution trust was healthy, runtime kits
were healthy, rollout health was healthy, and watch reliability was healthy with `0` errors over the 15-minute window.
The earlier controller readiness failure has recovered.

That recovery exposes the next reliability problem. Positive authority and negative authority now disagree. Jangar
dependency quorum still returns `block` because Torghut empirical jobs are stale. The same status payload emits valid
shadow failure-domain leases that allow `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital`.
Torghut is `Healthy` but `OutOfSync` in Argo CD, live `/readyz` and `/trading/health` return HTTP `503`, live submission
is disabled, the live route says typed quant health is not configured, live account quant health is reachable but stale
with `metricsPipelineLagSeconds=64604`, sim account quant health is empty, market-context health for `AAPL` is degraded,
and there are `199` open quant alerts. A human can understand that this should keep serving and repair open while
holding capital and widening. The system should not require a human to settle that contradiction every time.

The selected design makes contradictions first-class. Jangar will write one settlement record whenever an action has
both allow evidence and block/hold evidence. The record does not merely say "degraded." It names the contradictory
authorities, assigns the threatened action classes, decides which actions stay open, and publishes a ranked proof-repair
auction for the work most likely to improve Torghut profitability without increasing live risk.

The tradeoff is that material actions get one more required receipt. I accept that. The next six-month failure mode is
not missing liveness. It is confident promotion from a locally healthy control plane while consumer proof, GitOps
convergence, and empirical profitability evidence are still stale or contradictory.

## Evidence Snapshot

All cluster and database checks for this decision were read-only. No Kubernetes resources, database rows, broker topics,
trading flags, or Argo applications were mutated.

### Cluster And Rollout Evidence

- Runtime identity: `system:serviceaccount:agents:agents-sa`.
- Branch: `codex/swarm-jangar-control-plane-plan`, based on `main`.
- Jangar namespace pods were running, including `jangar-8667d6449-8ktm9`, `jangar-db-1`, Bumba, Redis, Open WebUI,
  Alloy, Symphony, and `symphony-jangar`.
- `deployment/jangar` was `1/1` available on image
  `registry.ide-newton.ts.net/lab/jangar:856f5579@sha256:ddcf27ec8bc22bdef4cc53309845452a6416236b8cd83d57185b7fb252cec45c`.
- `deployment/agents` was `1/1` and `deployment/agents-controllers` was `2/2` available.
- The agents namespace still carried retained execution debt: `32` Failed/Error pods, `7` Running pods, and `149`
  Succeeded pods in the phase sample.
- Recent agents events still included readiness probe timeouts for `agents-8665748649-8zkrj` and
  `agents-controllers-69b9f9dd59-7krc7` even though the rollouts were available.
- Argo CD reported `agents` and `jangar` as `Synced` and `Healthy`. The latest direct application reads showed both at
  revision `01d901b6f4c4b4e279af48d972dfc8c5270cb815` with the last operation succeeded.
- Argo CD reported `torghut` as `OutOfSync` and `Healthy`. Out-of-sync resources included `torghut-strategy-config`,
  four simulation `AnalysisTemplate` resources, `torghut-historical-simulation`, `torghut-empirical-promotion`, and
  Knative services `torghut` and `torghut-sim`.
- Torghut live, sim, ClickHouse, Keeper, Postgres, options, TA, websocket, Alloy, and Symphony pods were running.
- Recent Torghut events included failed simulation activity analysis, sim startup/readiness probe misses that later
  cleared, duplicate ClickHouse PodDisruptionBudget matches, Keeper PDB `NoPods`, and a `torghut-db-1` readiness probe
  returning HTTP `500`.

### Database And Data Evidence

- Direct `kubectl cnpg psql -n jangar jangar-db -- -c 'select 1'` failed because the service account cannot create
  `pods/exec` in the `jangar` namespace. This is an expected RBAC boundary and means deployer verification must use
  service-owned projections.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`, `connected=true`,
  `status=healthy`, `latency_ms=15`, registered migrations `28`, applied migrations `28`, and latest applied migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar `/ready` returned HTTP `200` with leader election active, execution trust healthy, runtime kits healthy, and
  serving/swarm admission passports allowed.
- Jangar control-plane status reported watch reliability healthy: `5` streams, `4124` events, `0` errors, and `5`
  restarts in the 15-minute window.
- Jangar dependency quorum still returned `decision=block` with reason `empirical_jobs_degraded`.
- Failure-domain leases were valid in shadow for database, route, rollout, registry, storage, workflow artifact, NATS,
  and source schema. Shadow holdbacks allowed `deploy_widen`, `merge_ready`, and `torghut_capital`.
- Torghut `/db-check` returned HTTP `200`, `ok=true`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`.
- Torghut `/readyz` returned HTTP `503`, `status=degraded`, and `live_submission_gate.allowed=false` with reason
  `simple_submit_disabled`.
- Torghut `/trading/health` returned HTTP `503`; quant evidence was informational only with
  `quant_health_not_configured` for the live route.
- Torghut `/trading/autonomy` returned stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all created from the `torghut-full-day-20260318-884bec35` dataset.
- Jangar typed quant health for live account `PA3SX7FYNUTF`, window `15m`, returned HTTP `200` with `status=ok`, but
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z` and `metricsPipelineLagSeconds=64604`. It is routable, not fresh.
- Jangar typed quant health for `TORGHUT_SIM`, window `15m`, returned `status=degraded`, `latestMetricsCount=0`, and
  `emptyLatestStoreAlarm=true`.
- The quant alerts route returned `199` open alerts: `105` critical and `94` warning.
- Market-context health for `AAPL` returned `overallState=degraded`, `bundleFreshnessSeconds=140740`, and stale
  technicals, fundamentals, news, and regime domains.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database status, controller health, rollout health,
  watch reliability, workflow reliability, empirical services, runtime admission, failure-domain leases, and execution
  trust into the status payload.
- `services/jangar/src/server/control-plane-workflows.ts` turns empirical-job and watch reliability state into
  dependency quorum. It is the right producer for global negative authority, not the final action router.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` evaluates local infrastructure domains and can
  allow `torghut_capital` in shadow when local leases are valid. It does not consume Torghut live readiness,
  account-scoped quant freshness, market-context freshness, or empirical-job age.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` exposes a typed quant-health route
  and correctly marks account/window-scoped pipeline health as scoped only when account and window are provided.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the highest-risk Jangar module at `2883`
  lines and owns schedule generation, runner ConfigMaps, CronJobs, swarm admission, requirements, freezes, workspace
  state, and PVC lifecycle.
- `services/torghut/app/main.py` remains the highest-risk Torghut route assembly point at `4051` lines. It owns
  readiness, DB checks, trading health, autonomy projection, decisions, executions, and data projections.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4347` lines and still owns market-context observations,
  rejection accounting, LLM decision context, signal continuity, and order-submission preparation.
- Focused tests already exist for Jangar control-plane status, failure-domain leases, runtime admission, watch
  reliability, Torghut quant metrics, Torghut market context, Torghut DB checks, and submission-council quant health.
  The missing system-level test is contradiction settlement across these independently truthful producers.

## Problem

Jangar is now good enough at collecting facts that the next risk is unresolved disagreement between facts.

The current state has five true statements:

1. Jangar and Agents are rolled out and serving.
2. Jangar database/schema projection is current.
3. Jangar dependency quorum blocks material authority because empirical jobs are stale.
4. Failure-domain leases still allow material action classes in shadow because local infrastructure domains are valid.
5. Torghut can be Kubernetes-healthy while live capital proof, GitOps convergence, account quant health, market context,
   and empirical proof are not capital-grade.

Those statements should not collapse into either a global green or a global freeze. Serving, observation, and proof
repair should stay open. Normal dispatch, deploy widening, merge readiness, paper canaries, and live capital need a
settled verdict that cites the contradiction and the repair path.

The architecture gap is settlement. Existing reducers produce local truths. None is explicitly accountable for saying:
"these truths conflict, this action is held, this repair is worth running next, and this is the evidence that will close
the hold."

## Alternatives Considered

### Option A: Let Dependency Quorum Override Every Conflicting Allow

Pros:

- Conservative for capital and deployment widening.
- Easy to explain in a degraded operations channel.
- Reuses the existing `dependency_quorum.decision=block` value.

Cons:

- Freezes proof repair and observation even when they are the only path to clear the block.
- Does not explain why failure-domain leases still advertise material action allowance.
- Treats stale empirical jobs the same as live rollout failure.
- Gives Torghut no measurable repair-priority signal.

Decision: reject as the normal operating model. Keep it as the emergency posture for unknown hard failures.

### Option B: Let Action SLO Budgets Be The Final Answer

Pros:

- Builds on the accepted negative-evidence router.
- Already separates action classes instead of one global readiness bit.
- Smaller implementation than a new settlement object.

Cons:

- Budgets say how much action is allowed, but not why two authorities disagree.
- They do not force a closure receipt when an allow and block coexist.
- They do not price proof repairs by expected profit or by contradiction-reduction value.

Decision: reject as final authority. Action SLO budgets remain inputs to settlement.

### Option C: Contradiction Settlement Ledger With Profit Repair Auction

Pros:

- Converts positive/negative authority conflicts into one auditable material-action verdict.
- Keeps read-only serving, observation, and bounded repair open while holding capital and widening.
- Gives engineer and deployer stages concrete acceptance gates: settlement id, decision, contradiction refs, repair
  bids, closure evidence, and rollback target.
- Lets Torghut rank proof repairs by expected profit value instead of treating every stale signal as equal.
- Reduces manual interpretation during market windows and image transitions.

Cons:

- Adds another durable projection.
- Requires careful action taxonomy so old audit debt does not permanently hold new work.
- Requires Torghut to publish repair-value metadata before profit repair ranking is fully useful.

Decision: select Option C.

## Architecture

Jangar adds two projections: `control_plane_contradiction_settlement` and `profit_repair_auction`.

```text
control_plane_contradiction_settlement
  settlement_id
  generated_at
  expires_at
  action_class                 # serve_readonly, dispatch_repair, dispatch_normal, deploy_widen,
                               # merge_ready, torghut_observe, paper_canary, live_micro_canary, live_scale
  scope                        # namespace, swarm, PR, rollout digest, account, strategy, window, or hypothesis
  positive_authority_refs
  negative_authority_refs
  contradiction_type           # local_allow_global_block, gitops_runtime_split, consumer_health_split,
                               # fresh_global_stale_scoped, route_ok_capital_blocked
  decision                     # allow, observe_only, repair_only, shadow_only, hold, block
  decision_reason_codes
  required_closure_receipts
  profit_repair_auction_id
  rollback_target
```

```text
profit_repair_auction
  auction_id
  settlement_id
  bids
    bid_id
    repair_class               # empirical_replay, market_context_refresh, quant_latest_backfill,
                               # live_quant_wiring, gitops_convergence, data_plane_rollout_hygiene
    owner_surface              # jangar, torghut, torghut-sim, deployer, engineer
    expected_profit_value      # low, medium, high, critical
    expected_risk_reduction
    max_runtime_minutes
    max_query_budget
    max_notional               # always 0 until paper settlement allows more
    guardrails
    closure_receipt_schema
```

Settlement rules:

- `serve_readonly` is allowed when Jangar route, leader election, DB projection, and runtime-kit evidence are healthy.
- `torghut_observe` is allowed when it only records evidence and consumes bounded routes.
- `dispatch_repair` is allowed when the repair can close a named contradiction and does not require live capital.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` are held when any positive Jangar authority conflicts with
  dependency quorum, GitOps convergence, or current consumer health.
- `paper_canary` requires no unresolved settlement for its account, strategy, window, hypothesis, and market session.
- `live_micro_canary` requires a closed paper settlement, broker reconciliation, TCA freshness, and an explicit human
  rollout window.
- `live_scale` is out of scope until micro-canary settlement exists across multiple market sessions.

Profit repair bids are ranked by this order:

1. Repairs that close a hard capital contradiction with zero live notional.
2. Repairs that unlock paper canary eligibility for a named hypothesis.
3. Repairs that reduce DB/query pressure on hot readiness paths.
4. Repairs that reduce deployment or GitOps ambiguity for rollout widening.
5. Repairs that only retire historical audit debt.

## Implementation Scope

Engineer scope:

- Add a pure contradiction-settlement reducer in Jangar that consumes dependency quorum, failure-domain leases, rollout
  health, GitOps convergence input, Torghut health summaries, typed quant health, quant alerts, and market-context
  health.
- Persist or project `control_plane_contradiction_settlement` in shadow mode with stable ids and closure receipts.
- Extend `/api/agents/control-plane/status` with active settlements by action class and scope.
- Ensure failure-domain lease allowance cannot be displayed as final authority when a settlement holds that action.
- Add a `profit_repair_auction` projection seeded from known repair classes: empirical replay, market-context refresh,
  account/window quant latest backfill, live quant-health wiring, GitOps convergence, and data-plane rollout hygiene.
- Add unit tests for conflicting `dependency_quorum=block` and failure-domain `torghut_capital=allow` producing
  `torghut_capital=hold` with `dispatch_repair=allow`.
- Add unit tests for fresh route health plus stale account quant proof producing `torghut_observe=allow` and
  `paper_canary=hold`.

Torghut engineer scope:

- Emit repair-value metadata from autonomy and readiness surfaces: candidate id, expected alpha class, proof age,
  account, strategy, window, and required closure receipt.
- Make live and sim quant-health wiring parity visible in `/trading/health`.
- Publish empirical replay closure receipts for the four stale jobs before any paper-capital readmission.
- Keep live notional at `0` until Jangar settlement returns `paper_canary=allow` and Torghut paper canary closes.

Deployer scope:

- Treat settlement id, not pod readiness alone, as the merge/widen/capital gate.
- Before widening Jangar or Torghut, show the active `deploy_widen` settlement and rollback target.
- Before paper capital, show the account/strategy/window settlement, closure receipts, and max notional.
- Before live capital, require a separate live-micro settlement and rollback drill evidence.

Non-goals:

- No mutation of current live trading flags in this design PR.
- No replacement of dependency quorum, failure-domain leases, session proof settlement, or GitOps escrow.
- No privileged database shell requirement for normal verification.

## Validation Gates

Engineer acceptance:

- Unit tests cover at least five contradiction types:
  `local_allow_global_block`, `gitops_runtime_split`, `consumer_health_split`, `fresh_global_stale_scoped`, and
  `route_ok_capital_blocked`.
- Route tests prove `/api/agents/control-plane/status` includes settlement ids, action decisions, contradiction refs,
  closure receipt refs, and repair-auction ids.
- Tests prove `serve_readonly` remains allowed when capital is held by stale empirical jobs.
- Tests prove old retained failed AgentRuns do not hold `dispatch_repair` unless they map to a current action scope.
- Torghut tests prove live quant-health not configured and sim account empty quant health become separate repair bids.

Deployer acceptance:

- A deployer can capture a single settlement id for `deploy_widen` before widening Jangar or Torghut.
- A deployer can show `torghut_capital` is `hold` while empirical jobs are stale, account quant proof is stale, live
  route quant health is not configured, or Torghut is OutOfSync.
- A deployer can show `dispatch_repair=allow` with `max_notional=0` for the top repair bid.
- Rollback drills show settlement enforcement can be disabled while keeping dependency quorum and failure-domain lease
  behavior unchanged.

Profit acceptance:

- Within two market sessions of implementation, the system should reduce open scoped quant alerts by at least `50%` or
  emit closure receipts explaining why each remaining alert is still valid.
- The first paper-canary candidate must cite empirical replay freshness, market-context freshness, account/window quant
  freshness, and no unresolved capital settlement.
- Live capital remains disabled until paper canary PnL, TCA, broker reconciliation, and rollback rehearsal are recorded.

## Rollout Plan

1. Ship the settlement reducer in shadow mode and display decisions next to dependency quorum and failure-domain
   leases.
2. Add repair-auction projection for empirical replay, quant latest backfill, market-context refresh, and live
   quant-health wiring.
3. Teach deploy verification to require `deploy_widen` settlement visibility, but do not enforce hold decisions yet.
4. Enforce settlement for `merge_ready` and `deploy_widen` after seven consecutive healthy settlement epochs.
5. Enforce settlement for paper capital after Torghut emits closure receipts for empirical replay and account/window
   quant health.
6. Keep live capital under explicit human approval until paper canary settlement has passed across multiple sessions.

## Rollback Plan

- Disable settlement enforcement with a feature flag and continue using dependency quorum, failure-domain leases, and
  current Torghut submission gates.
- Keep writing shadow settlement records during rollback so engineers can compare old and new decisions.
- If repair-auction ranking causes harmful starvation, fall back to fixed priority: empirical replay, quant backfill,
  market-context refresh, GitOps convergence, rollout hygiene.
- If a settlement id is malformed or stale, deployers must hold `deploy_widen`, `merge_ready`, paper capital, and live
  capital while leaving `serve_readonly`, `torghut_observe`, and explicitly scoped repair open.

## Risks

- The reducer can become another broad status object. Mitigation: require every settlement to name action class, scope,
  positive refs, negative refs, closure receipts, and expiry.
- Repair bids can overfit to stale profit estimates. Mitigation: cap live notional at `0`, require paper canary
  evidence, and expire bid value after the market session.
- GitOps ignored differences can be treated too loosely. Mitigation: hash ignored differences into the settlement and
  require deployer visibility before widening.
- Historical audit debt can hold too much. Mitigation: separate retained audit negatives from current action-scope
  contradictions.

## Handoff

Engineer handoff:

- Build the contradiction-settlement reducer first, with fixtures from this document.
- Keep the first reducer pure and route-independent.
- Add the API projection only after unit tests cover the five contradiction types.
- Do not enforce capital or deployment holds until shadow records have stable ids and closure receipt refs.

Deployer handoff:

- Use this document as the acceptance contract for `deploy_widen`, `merge_ready`, paper canary, and live-capital gates.
- Read Jangar status, Torghut health, Argo Application state, typed quant health, market-context health, and empirical
  jobs as inputs. The final material-action answer is the settlement id.
- During rollout, report three numbers in release notes: open settlements by action class, top repair bid, and oldest
  unresolved capital settlement age.
