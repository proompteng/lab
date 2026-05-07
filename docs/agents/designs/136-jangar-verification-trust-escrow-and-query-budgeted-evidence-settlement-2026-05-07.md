# 136. Jangar Verification Trust Escrow And Query-Budgeted Evidence Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane execution trust, verify-stage freshness, bounded evidence reads, rollout safety,
Torghut quant evidence custody, validation, rollout, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/140-torghut-post-cost-alpha-reentry-and-proof-query-market-2026-05-07.md`

Extends:

- `135-jangar-rollout-availability-escrow-and-consumer-evidence-custody-2026-05-07.md`
- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
- `134-jangar-evidence-census-and-projection-settlement-exchange-2026-05-07.md`
- `129-jangar-consumer-evidence-return-ledger-and-rollout-settlement-2026-05-06.md`

## Decision

I am selecting **verification trust escrow with query-budgeted evidence settlement** as the next Jangar control-plane
architecture step.

The refreshed read-only pass at `2026-05-07T08:12Z` shows a system that is serving, but still not trustworthy enough
to let downstream capital consumers infer safety from live HTTP aggregation. Jangar is on image
`1744b973@sha256:fe165d874349d309ae43fdeedd64934f0dde6cd748c92dade8992e86c2dfbaa3`; `deployment/jangar` is `1/1`
available and `deployment/agents-controllers` is `2/2` available. `/ready` returns `status=ok`, healthy serving and
collaboration runtime kits, and proof that `bun`, `codex-nats-publish`, `codex-nats-soak`, `nats`, the Jangar
workspace, and `NATS_URL` are present.

The same `/ready` payload degrades execution trust because the verify stage is stale. `GET
/api/agents/control-plane/status` timed out under a 15 second client budget, while `/ready` had enough settled data to
answer. Jangar also holds roughly `51M` rows in `torghut_control_plane.quant_pipeline_health`; a direct recent
15-minute aggregation over that table timed out under a 5 second statement budget, even after recent index work.
Those are not just endpoint bugs. They are a proof-shape problem: request-time readers are still allowed to do too
much evidence interpretation against hot production tables.

I am not choosing another one-off status optimization. Jangar needs to settle execution trust, query cost, and
consumer evidence into small receipts before serving routes and material-action gates consume them. The tradeoff is
one more internal receipt family and stricter freshness deadlines for verify-stage proof. I accept that because the
observed failure mode is exactly stale or expensive evidence being discovered late, at the HTTP or capital boundary,
instead of being converted into a current hold/repair decision ahead of time.

## Runtime Objective And Success Metrics

This contract increases control-plane resilience by moving expensive and stale-prone evidence work out of user-facing
reads and into bounded settlement loops.

Success means:

- `/ready` and `/api/agents/control-plane/status` read a settled verification trust receipt, not live-scan verify jobs
  or high-cardinality quant tables.
- Verify-stage staleness is represented as an escrowed repair debt with owner, deadline, last good receipt, and action
  effects.
- Jangar refuses deploy widening, merge-ready claims, and Torghut paper/live custody when the verify trust receipt is
  stale, while still allowing read-only serving and zero-notional repair.
- Query budgets are explicit: status routes cannot run unbounded aggregation over `quant_pipeline_health`,
  `quant_metrics_series`, AgentRun history, or Torghut data-plane proof tables.
- A slow proof query produces `query_budget_exhausted` evidence and a repair bid instead of timing out the control
  surface.
- Engineer and deployer stages can validate the contract with bounded HTTP checks, migration checks, and receipt
  freshness checks without database mutation.

Initial SLOs:

- `/ready` p95 under `1s` and `/api/agents/control-plane/status` p95 under `2s` for a 10 request smoke.
- Verification trust receipts refresh at least every `5m`; stale after `2` missed verify windows.
- Query-budgeted settlement records the largest bounded proof query per cycle and caps route-time DB work at `250ms`
  per evidence family.
- No material-action receipt may widen from `repair_only` to `paper_hold` or `current` while verify trust is stale.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests,
AgentRuns, broker state, or Torghut trading flags.

### Cluster And Rollout Evidence

- `kubectl config current-context` was initially unset; I created a local `in-cluster` kubeconfig context from the
  service-account token so follow-up reads are reproducible.
- `kubectl auth whoami` identified the caller as `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were Running: `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI, Symphony,
  and `symphony-jangar`.
- `deployment/jangar` was `1/1` available on image `1744b973`; recent events still showed readiness probe failures
  during image replacement and `NoPods` events for an Elasticsearch PDB with no matching pods.
- Agents controllers recovered from the earlier teammate soak: `deployment/agents-controllers` was `2/2` available,
  but the namespace still contained several recent failed scheduled jobs followed by successful reruns.
- Torghut serving and sim revisions were Running, but its events repeatedly warned that ClickHouse pods match multiple
  PDBs. The current service account cannot list PDBs, Argo Rollouts, Knative services, CNPG clusters, or exec into DB
  pods, so the design must not depend on manual privileged inspection as the normal validation path.

### Route And Runtime Evidence

- `GET http://jangar.ide-newton.ts.net/ready` returned `status=ok` with healthy runtime kits and fresh projection
  watermarks, while `execution_trust.status=degraded` because `jangar-control-plane:verify` is stale.
- The same `/ready` payload shows in-process agents and supporting controllers disabled while the orchestration
  controller is enabled; split authority must therefore be read from receipts, not guessed from one process.
- `GET http://jangar.ide-newton.ts.net/api/agents/control-plane/status` timed out after `15s`.
- `GET http://jangar.ide-newton.ts.net/api/torghut/trading/control-plane/quant/health` returned `ok=true`,
  `latestMetricsCount=4032`, `metricsPipelineLagSeconds=0`, and `pipelineHealthSkippedReason=account_and_window_required`
  for the unscoped route.
- Runtime proof for NATS is now healthy: the collaboration kit includes `codex-nats-publish`, `codex-nats-soak`,
  `nats`, workspace, and `NATS_URL`.

### Database And Data Evidence

- Jangar DB connected as application user `jangar`.
- `pg_stat_user_tables` estimates:
  - `torghut_control_plane.quant_pipeline_health`: about `50,969,757` rows.
  - `torghut_control_plane.quant_metrics_series`: about `3,722,580` rows.
  - `torghut_control_plane.quant_metrics_latest`: `4,032` rows.
  - `agent_runs`: estimate `783`, exact application count `469`.
- Small freshness reads are current enough for custody:
  - `quant_metrics_latest` exact rows `4032`, latest update `2026-05-07 08:19:03+00`.
  - `agent_runs` exact rows `469`, latest update `2026-05-07 08:19:06+00`.
- A recent aggregation over `quant_pipeline_health` grouped by account/stage for the last 15 minutes timed out under a
  5 second statement budget. That table must be treated as an input to settlement, not as a route-time dependency.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `781` lines and already composes execution trust, dependency
  quorum, runtime admission, material action, Torghut empirical services, and rollout health.
- `services/jangar/src/server/torghut-quant-runtime.ts` is `817` lines and computes live metrics continuously.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` is `399` lines and owns writes into the quant control
  plane tables.
- Existing tests cover control-plane status, runtime admission, negative evidence routing, action clocks, and quant
  metrics store migrations. The missing test surface is a route-independent settlement receipt that proves status
  routes can stay bounded when a large evidence table is slow.

## Problem

Jangar is doing two jobs at the same boundary: presenting control-plane truth and discovering whether control-plane
truth is cheap, fresh, and safe enough to consume.

That creates four failure modes:

1. **Stage trust becomes a late read failure.** A stale verify stage can degrade `/ready`, while another status route
   times out instead of serving the same stale-trust decision from a receipt.
2. **Hot evidence tables leak into the route path.** A table with tens of millions of quant stage rows can still be
   queried in ways that exceed a normal operator HTTP budget.
3. **Runtime-kit health is not enough.** Helper binaries and NATS can be present while verify evidence is stale.
4. **Consumers get data instead of custody.** Torghut needs an action-class answer: observe, repair, paper hold, or
   live block. It should not re-interpret Jangar stage staleness, runtime proof, and query pressure itself.

## Alternatives Considered

### Option A: Fix The Verify Cron And Add A Faster Status Query

Pros:

- Fastest tactical remediation.
- Likely removes the current `verify stage is stale` reason.
- Keeps the existing public payload shape mostly intact.

Cons:

- Does not prevent the next large table or slow proof read from timing out the route.
- Does not create a durable query-budget audit trail.
- Leaves Torghut to interpret multiple Jangar internals for capital decisions.

Decision: reject as the architecture answer. Keep it as an engineer repair task under the selected design.

### Option B: Put All Control-Plane Reads Behind A Single Cache

Pros:

- Simple latency improvement.
- Reduces repeated DB/API work.
- Easy to deploy incrementally.

Cons:

- Caches can preserve bad or stale interpretations without naming the trust debt.
- It does not separate execution trust, query budget, and consumer custody.
- It can mask a stale verify stage until the cache expires.

Decision: reject.

### Option C: Verification Trust Escrow With Query-Budgeted Evidence Settlement

Pros:

- Converts stale verify evidence into an explicit escrow state with action effects.
- Converts slow proof queries into `query_budget_exhausted` repair evidence before route timeout.
- Gives Torghut a small custody receipt rather than a large status payload to reinterpret.
- Keeps Jangar read-only and repair surfaces available while holding deploy widening and capital authority.

Cons:

- Adds a settlement loop and one receipt family.
- Requires careful query-budget calibration so it does not over-hold routine operations.
- Requires both Jangar and Torghut code to prefer receipts over direct live aggregation.

Decision: select Option C.

## Architecture

Jangar emits one verification trust escrow receipt per swarm/stage and one query-budget settlement receipt per evidence
family.

```text
verification_trust_escrow_receipt
  receipt_id
  generated_at
  swarm_name
  stage
  stage_owner
  last_good_run_ref
  last_good_completed_at
  expected_interval_seconds
  stale_after_seconds
  trust_state              # current, stale, missing, blocked
  action_effects           # serve_readonly, repair_only, hold_dispatch, hold_capital
  repair_bid_ref
  reason_codes
  fresh_until
```

```text
query_budget_settlement_receipt
  receipt_id
  generated_at
  evidence_family          # control_plane_status, quant_pipeline_health, agent_runs, torghut_custody
  source_table_or_route
  row_estimate
  query_budget_ms
  observed_query_ms
  result_state             # current, stale, skipped, query_budget_exhausted
  route_consumers
  fallback_receipt_ref
  required_index_or_rollup
  reason_codes
  fresh_until
```

Material action consumers use the receipts, not the underlying heavy tables:

- `serve_readonly`: allowed when runtime kits are current and verification trust is not `blocked`.
- `dispatch_repair`: allowed under `stale` verify when the repair bid is scoped and query budgets are not exhausted
  for the repair family.
- `dispatch_normal`: requires current verification trust and no query-budget exhaustion on control-plane status.
- `deploy_widen` and `merge_ready`: require current verification trust, current rollout availability escrow, and
  bounded status route receipts.
- `torghut_observe`: allowed with `max_notional=0` under stale verify.
- `paper_canary` and live actions: require current verification trust plus current Torghut custody receipts.

## Implementation Scope

Engineer stage should implement the smallest production slice:

- Add a Jangar settlement module that materializes verification trust escrow from stage schedule/result state already
  exposed in control-plane status.
- Add query-budget settlement for control-plane status, quant latest, quant pipeline health, and AgentRun history.
- Change `/api/agents/control-plane/status` to consume settled receipts for expensive evidence families and to emit a
  bounded degraded response when a settlement receipt is stale.
- Keep `/ready` as the compact serving readiness surface, but include receipt ids for stale verify and query-budget
  holds.
- Add route tests proving that stale verify produces a bounded degraded payload without route-time large-table
  aggregation.
- Add store tests proving that a query timeout becomes `query_budget_exhausted` and a repair bid, not an unhandled
  route timeout.

Do not mutate cluster resources or database rows in the design phase. The deployer may later apply GitOps changes
only after the engineer receipts and tests exist.

## Validation Gates

Engineer acceptance:

- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/torghut-quant-metrics-store.test.ts`
- New tests cover stale verify, query-budget exhaustion, and bounded status response.
- `curl -m 5 http://jangar.ide-newton.ts.net/ready` returns a compact receipt-backed answer.
- `curl -m 5 http://jangar.ide-newton.ts.net/api/agents/control-plane/status` returns within budget, even when a
  heavy proof family is stale or skipped.

Deployer acceptance:

- Jangar rollout stays `1/1` or better during the deploy window.
- Verification trust receipt is `current` before merge-ready or deploy-widen action classes are released.
- Query-budget receipts are `current` or explicitly `skipped` with a valid fallback for every public status route.
- Torghut custody receipt remains `observe_only` or `repair_only` until the companion Torghut post-cost gates pass.

## Rollout

1. Ship the settlement module behind a read-only feature flag that emits receipts without changing action decisions.
2. Compare receipt decisions against current `/ready` and control-plane status for one full verify cycle.
3. Switch status routes to receipt-backed reads for high-cardinality evidence families.
4. Enforce action-class holds for stale verify and query-budget exhaustion.
5. Allow Torghut to consume the custody receipt for observe and repair first; paper/live remain blocked.

## Rollback

Rollback does not require database mutation.

- Disable enforcement and keep receipt emission read-only if route latency worsens.
- Revert status routes to the previous reducer while keeping the settlement table ignored.
- Force material actions to `serve_readonly` and `repair_only` if receipts contradict current `/ready` evidence.
- Do not widen deploy or capital classes while rollback evidence is being collected.

## Risks

- Query budgets may initially be too strict and over-hold repair work.
- Existing indexes may still be insufficient for some settlement reads; the receipt should say so rather than hiding
  timeout.
- Split controller authority can confuse operators if the receipt does not name which process or deployment owns the
  evidence.
- Route-level caching must not bypass receipt freshness.

## Handoff Contract

Engineer owns the Jangar receipt implementation, bounded route behavior, and tests. Deployer owns GitOps rollout and
the validation evidence. Torghut consumers may treat stale verify as `max_notional=0`, not as a full outage, until the
receipt becomes `current`.

The next stage is done only when stale verify and slow proof queries are visible as settled receipts and no public
status route needs an unbounded scan to answer a capital or rollout question.
