# 99. Jangar Proof Gap Auction And Hypothesis Rehydration Runway (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders
Scope: Jangar action-class resilience, Torghut proof-gap repair budgeting, hypothesis rehydration handoff, safe
rollout, rollback, and capital admission guardrails.

Companion Torghut contract:

- `docs/torghut/design-system/v6/103-torghut-hypothesis-rehydration-and-proof-gap-auction-2026-05-06.md`

Extends:

- `98-jangar-action-slo-budget-and-profit-proof-exchange-2026-05-06.md`
- `97-jangar-scoped-proof-lease-arbiter-and-capital-reentry-settlement-2026-05-06.md`
- `96-jangar-observed-action-authority-and-negative-evidence-reclocking-2026-05-06.md`
- `docs/torghut/design-system/v6/102-torghut-profit-proof-exchange-and-capital-slo-budget-2026-05-06.md`

## Decision

I am choosing a **proof-gap auction with a hypothesis rehydration runway** as the next Jangar architecture step for
Torghut quant.

The prior profit-proof exchange correctly keeps capital closed when proof is missing. The live system now needs a
stronger repair architecture, because the current evidence says Torghut is safe but inert. Jangar is serving, its
runtime-kit view is healthy, the agents controller rollout is available, and Torghut is healthy at the route and Argo
levels. At the same time, Torghut has zero populated `strategy_hypotheses`, only skipped `research_runs`, stale rejected
decisions, no execution correlation IDs on historical execution rows, stale market-context domains, and account/window
quant evidence that still lacks pipeline-stage settlement.

A gate-only exchange can explain why capital is blocked. It does not decide which proof gap should be repaired first,
which repair action is allowed under current control-plane SLO, or how a repaired hypothesis earns capital again. Jangar
should turn missing proof into expiring, priced repair lots. Torghut should consume those lots to rehydrate hypotheses,
run shadow micro-sessions, and publish compact profit receipts back to Jangar.

The tradeoff is more machinery in the repair path. I accept that because the current failure mode is not a single outage.
It is proof illiquidity: enough infrastructure is up to do work, but the system lacks fresh, scoped, profitable evidence
to spend capital.

## Read-Only Evidence Snapshot

All evidence for this design pass was read-only. I did not mutate Kubernetes resources, database rows, or trading
controls.

### Runtime And Branch Evidence

- Repository: `proompteng/lab`.
- Base branch: `main`.
- Head branch: `codex/swarm-torghut-quant-discover`.
- Local branch was clean at `d7521779328d92f1a2b90b5774c7d331448f7f6c` before this design change.
- `kubectl config current-context` was unset, so I initialized the in-cluster context from the service account and
  verified identity as `system:serviceaccount:agents:agents-sa`.

### Cluster And Rollout Evidence

- `jangar` namespace pods were ready, including `jangar-7c4bbdd45-sgqpg` at `2/2 Running`, `jangar-db-1` at
  `1/1 Running`, and `bumba-847bf8c449-j4d76` at `1/1 Running`.
- `agents` namespace Deployments were available: `agents` `1/1`, `agents-controllers` `2/2`, and `agents-alloy` `1/1`.
- Recent `agents` events still showed readiness probe timeouts on `agents-controllers-*` and `agents-*`, plus multiple
  failed verify-stage AgentRuns. This is action-class debt, not a full serving outage.
- `torghut` Argo CD application moved from `Synced/Progressing` during a new Knative revision to `Synced/Healthy`.
- Current Torghut route returned version `v0.568.5-109-gd75217793` and commit
  `d7521779328d92f1a2b90b5774c7d331448f7f6c`.
- The live revision `torghut-00227` became `2/2 Running`. The sim revision `torghut-sim-00308` was still observed
  terminating one container during the replacement window, so deployer gates must require settled live and sim
  revisions before widening.
- ClickHouse, Keeper, Postgres, TA, WebSocket, options catalog, options enricher, options TA, guardrail exporters, and
  Alloy were running.

### Route Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `status=ok`.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`, healthy execution trust, healthy memory
  provider, and healthy collaboration runtime-kit evidence including `codex-nats-publish`, `codex-nats-soak`, and
  `nats`.
- `GET /api/agents/control-plane/status?namespace=agents` reported healthy controller authority and healthy execution
  trust.
- `GET /api/torghut/trading/control-plane/quant/health?window=1d` returned aggregate health with
  `latestMetricsCount=540`, `emptyLatestStoreAlarm=false`, `stageScopeOmitted=true`, and
  `pipelineHealthSkippedReason=account_and_window_required`.
- `GET /api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=1d` returned scoped health with
  `latestMetricsCount=108`, `emptyLatestStoreAlarm=false`, `stageScopeOmitted=false`, `metricsPipelineLagSeconds=31658`,
  and an empty `stages` array.
- `GET /api/torghut/market-context/health?symbol=AAPL` returned overall degraded market context. Technicals, news,
  fundamentals, and regime domains were stale even though the provider calls themselves were reachable.
- Torghut `/healthz` returned HTTP 200.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, Alembic head
  `0029_whitepaper_embedding_dimension_4096`, account-scope readiness, and no lineage errors. It still reported the
  known parent-fork lineage warnings.
- Torghut `/trading/status` returned live mode, `last_decision_at=2026-05-04T17:25:57.901670Z`,
  `dependency_quorum=block` for `empirical_jobs_degraded`, three hypotheses, zero promotion eligible, and three
  rollback required.
- Torghut `/trading/health` returned degraded with `simple_submit_disabled`, `capital_stage=shadow`, and
  `alpha_readiness.promotion_eligible_total=0`.

### Database And Data Evidence

- Direct CNPG `kubectl cnpg psql` was blocked by RBAC because the service account cannot create `pods/exec` in
  `torghut`. I used application database credentials from scoped Kubernetes secrets without printing secret values.
- Torghut SQL connected as `torghut_app` to database `torghut` at `2026-05-06T02:14:01Z`.
- Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- `trade_decisions` had only nine rows in the last seven days, all `rejected`, newest
  `2026-05-04T17:25:57.901Z`.
- Historical `trade_decisions` were dominated by `rejected` and `blocked`: 69,909 rejected, 63,552 blocked, 13,555
  filled, 370 planned, 217 canceled, and 3 expired.
- `executions` had 13,778 rows, newest `2026-04-02T20:59:45.104Z`; all 13,778 rows lacked
  `execution_correlation_id`.
- `research_runs` had 48 rows, all `skipped`, newest `2026-03-11T10:14:45.427Z`.
- `strategy_hypotheses` had zero rows.
- `torghut_options_watermarks` had 5,085 estimated live tuples and fresh autoanalyze at
  `2026-05-06T02:12:41.274Z`.
- Jangar SQL connected as `jangar` to database `jangar` at `2026-05-06T02:14:24Z`.
- Jangar `torghut_control_plane.quant_metrics_latest` had 3,780 rows, newest `as_of=2026-05-06T02:14:22.869Z`.
- Jangar `agent_runs` counted 141 failed, 106 succeeded, and 27 running rows. Recent verify failures are therefore
  real SLO debt, even while serving is healthy.
- Jangar controller heartbeats were fresh for orchestration, while `agents-controller`, `supporting-controller`, and
  `workflow-runtime` heartbeat rows were marked disabled in the application heartbeat table. The external rollout status
  still showed `agents-controllers` available, so the auction must record source and confidence for every controller
  claim.

### Source Evidence

- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` already distinguishes aggregate and
  scoped quant-health calls and marks unscoped stage evidence with `stageScopeOmitted`.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` already persists account/window latest metrics and can
  list pipeline health, so the auction can consume existing projection data before adding new storage.
- `services/jangar/src/server/control-plane-status.ts` and related control-plane modules already aggregate controller,
  workflow, rollout, execution trust, runtime-kit, empirical-service, and dependency-quorum evidence.
- `services/torghut/app/trading/submission_council.py` already blocks live submission on dependency quorum, empirical
  jobs, promotion eligibility, and typed quant-health failures.
- `services/torghut/app/trading/hypotheses.py` already maps dependency quorum into hypothesis state and promotion
  eligibility.
- `services/torghut/app/trading/empirical_jobs.py` already models empirical freshness and promotion authority.
- The missing architecture is not another health check. It is a repair marketplace that prioritizes proof gaps and turns
  their closure into capital receipts.

## Problem

The current control plane has enough health to act, but not enough proof to spend capital. That split creates five
failure modes:

1. **Green routes can hide proof gaps.** Jangar and Torghut routes are healthy while scoped quant stages are empty and
   market context is stale.
2. **Capital blockers do not create repair priority.** `empirical_jobs_degraded` and empty hypotheses block capital, but
   they do not rank the work needed to clear the block.
3. **Global dependency quorum is too blunt.** It should hold capital and broad dispatch, but it should not stop bounded
   repair runs that name the exact proof debt they retire.
4. **Hypothesis state is not populated from research.** Empty `strategy_hypotheses` and skipped-only `research_runs`
   mean Torghut has no measurable alpha inventory to auction for capital.
5. **Historical execution evidence is not stitchable.** Missing execution correlation IDs make old TCA and order data
   weak evidence for new capital decisions.

## Alternatives Considered

### Option A: Keep The Profit Proof Exchange As The Only New Contract

Pros:

- Preserves the strongest safety posture.
- Requires the least new Jangar surface area.
- Keeps capital fail-closed while evidence is weak.

Cons:

- Passive. It blocks capital but does not prioritize evidence repair.
- Does not tell engineers which proof gap has the highest leverage.
- Leaves normal dispatch and repair dispatch mixed inside the same dependency-quorum posture.

Decision: keep it as the capital gate, but do not stop there.

### Option B: Force A Quant And Empirical Refresh Before The Next Canary

Pros:

- Directly targets the two most visible blockers: scoped quant stage evidence and stale empirical authority.
- Fast to validate with existing routes.
- Could make one paper-candidate path look healthier quickly.

Cons:

- Still leaves `strategy_hypotheses` empty.
- Does not retire rejection drag or missing execution correlation.
- Risks running refresh jobs without a ranked repair budget, which recreates stale proof after the next rollout.

Decision: use refresh as one class of repair lot, not as the architecture.

### Option C: Proof-Gap Auction And Hypothesis Rehydration Runway

Jangar materializes proof-gap lots, assigns action-class budgets, and admits repair work only when a lot names its
proof debt, expected output, TTL, validation command, and capital impact. Torghut rehydrates hypotheses and publishes
profit receipts back to the exchange.

Pros:

- Converts negative evidence into prioritized repair work.
- Separates read-only, repair, normal dispatch, paper capital, and live capital.
- Gives Torghut a productive path from empty hypotheses to measurable shadow sessions.
- Keeps capital closed until repair lots produce scoped, fresh, profitable receipts.
- Improves rollout safety because deployer stages can ask which lots are still open before widening.

Cons:

- Adds a new read model and shared vocabulary.
- Requires engineers to maintain lot TTLs and proof-output schemas.
- Requires care so the auction does not become an unbounded task queue.

Decision: select Option C.

## Architecture

### ProofGapLot

Jangar emits one lot per concrete proof gap:

```text
proof_gap_lot
  lot_id
  generated_at
  fresh_until
  source_system
  account
  strategy_id
  hypothesis_id
  window
  gap_class
  observed_evidence
  missing_evidence
  repair_action_class
  expected_receipt
  capital_impact
  max_runtime_minutes
  validation_gate
  decision
```

Initial `gap_class` values:

- `hypothesis_inventory_empty`
- `research_chain_skipped`
- `empirical_authority_stale`
- `scoped_quant_stage_missing`
- `market_context_stale`
- `decision_rejection_drag`
- `execution_correlation_absent`
- `rollout_tail_unsettled`
- `verify_debt_unclassified`

### RepairRunwayBudget

Jangar adds a repair budget projection to the control-plane status payload:

```text
repair_runway_budget
  budget_id
  generated_at
  fresh_until
  allowed_repair_classes[]
  blocked_repair_classes[]
  active_lots[]
  saturated_lots[]
  capital_blockers[]
  rollout_holdbacks[]
  source_refs[]
```

Rules:

- `serve_readonly` and `observe` remain allowed while Jangar `/ready`, runtime kits, and database routes are healthy.
- `dispatch_repair` is allowed only when the AgentRun or job names a live `proof_gap_lot`.
- `dispatch_normal` remains held while verify debt is recent and unclassified.
- `deploy_widen` remains held while live or sim revisions are unsettled or probe-tail evidence is still inside the
  holdback window.
- `torghut_paper_capital` and `torghut_live_capital` remain blocked until no capital-critical lots are open for the
  target account, strategy, hypothesis, and window.

### Hypothesis Rehydration Runway

Jangar does not create Torghut hypotheses. It grants bounded repair capacity for Torghut to rehydrate them through the
companion contract. The output expected from Torghut is a compact `profit_rehydration_receipt`:

```text
profit_rehydration_receipt
  receipt_id
  lot_id
  hypothesis_id
  account
  window
  generated_at
  fresh_until
  source_research_refs
  shadow_session_refs
  rejection_retirement_refs
  quant_stage_refs
  market_context_refs
  empirical_refs
  decision
```

Jangar consumes only the receipt summary and route digests. It does not need broad database access to judge whether a
capital-critical lot is closed.

## Implementation Scope

Engineer stage should implement the smallest version that proves the loop:

- Add a Jangar proof-gap lot builder that consumes existing control-plane status, quant-health, workflow, rollout, and
  Torghut status projections.
- Add tests that generate lots for empty hypotheses, skipped research, stale empirical jobs, empty scoped quant stages,
  stale market context, and unclassified verify debt.
- Add a status projection for `repair_runway_budget` with action-class decisions and source refs.
- Add admission tests proving repair dispatch can proceed for a named lot while normal dispatch, deploy widening, paper
  capital, and live capital remain blocked.
- Add a Torghut companion route or projection that publishes rehydration receipts without placing orders.

This is not a license to run broad repair swarms. Initial concurrency should be one lot per gap class and one
capital-critical lot per account/window.

## Engineer Acceptance Gates

- Unit tests cover every initial `gap_class`.
- A Jangar test proves aggregate quant health with `stageScopeOmitted=true` creates `scoped_quant_stage_missing` and
  cannot close a capital-critical lot.
- A Jangar test proves scoped quant health with `metricsPipelineLagSeconds` above budget or empty `stages` keeps the lot
  open.
- A Jangar test proves recent verify failures debit `dispatch_normal`, `deploy_widen`, and `merge_ready` but still allow
  bounded `dispatch_repair` for a named lot.
- Torghut tests prove empty `strategy_hypotheses` and skipped-only `research_runs` create rehydration lots before any
  paper-capital receipt can pass.
- Tests assert every lot has `fresh_until`, `source_refs`, and a validation gate.

## Deployer Acceptance Gates

- Shadow publish the proof-gap auction for one full market session without changing runtime behavior.
- Confirm the auction emits at least these current lots: empty hypothesis inventory, skipped research chain, stale
  empirical authority, scoped quant stage missing, stale market context, rejection drag, and missing execution
  correlation.
- Confirm repair dispatch is bounded to named lots and normal dispatch remains held while verify debt is unclassified.
- Do not widen Torghut rollout while live or sim revision replacement is still visible in events or pod termination.
- Do not allow paper capital until Torghut closes all capital-critical lots for the target account/window and publishes a
  positive rehydration receipt.
- Do not allow live capital until paper receipts clear multiple sessions and live submission toggles are explicitly
  enabled.

## Rollout Plan

1. **Shadow projection:** Jangar publishes proof-gap lots and repair runway budget with no enforcement.
2. **Repair-only enforcement:** Jangar admits bounded repair runs only when they cite a live lot.
3. **Torghut receipt integration:** Torghut publishes rehydration receipts for shadow sessions and proof repair.
4. **Paper dry-run enforcement:** Jangar blocks paper dry runs unless all capital-critical lots are closed for the target
   scope.
5. **Paper capital enforcement:** Paper capital can spend only fresh positive receipts.
6. **Live capital enforcement:** Live remains blocked until paper receipts are positive across the agreed session count,
   kill switches are clear, and submission toggles are explicitly enabled.

## Rollback Plan

- Disable proof-gap auction enforcement and fall back to the existing profit-proof exchange and submission council.
- Treat all open proof-gap lots as advisory only.
- Expire all rehydration receipts emitted during the rollback window.
- Keep read-only status and observe routes available if Jangar `/ready` remains healthy.
- If the auction emits incorrect capital allowances, immediately set paper and live capital decisions to `block` and
  preserve the offending lot and receipt payloads for incident review.

## Risks

- The auction can become a backlog vanity metric if lots do not have TTLs and validation gates.
- Repair capacity can starve normal work if the budget does not cap concurrency.
- A fresh quant latest metric can still be over-read if empty stage evidence is ignored.
- Rehydrated hypotheses can become overfit if shadow micro-sessions are not tied to current rejection and cost evidence.
- Database secret access for read-only assessment is useful, but production audit should rely on route digests and
  explicit receipts rather than human SQL.

## Handoff Contract

Engineer stage owns lot generation, repair-budget projection, and Torghut rehydration receipt plumbing. Deployer stage
owns shadow publication, enforcement staging, and rollback drills. Capital remains closed until the target
account/window has fresh scoped quant stages, fresh empirical authority, populated hypothesis inventory, rejection drag
retired or budgeted, and positive paper receipts.
