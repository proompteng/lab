# 77. Torghut Hot-Path Proof Projections and Profit-Cell Settlement (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders)
Scope: Torghut quant readiness, profitability authority, data freshness, route budgets, Jangar admission, and
rollout/rollback gates.

Companion doc:

- `docs/agents/designs/72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md`

Extends:

- `75-torghut-cross-plane-evidence-epochs-and-profit-cell-governor-2026-05-05.md`
- `76-torghut-profit-projection-consumer-and-route-parity-gates-2026-05-05.md`
- `75-torghut-profit-authority-ledger-and-rehearsal-cells-2026-05-05.md`
- `74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`
- `72-torghut-profit-proof-exchange-and-query-firebreak-contract-2026-05-05.md`
- `71-torghut-whitepaper-autoresearch-profit-target-strategy-factory-2026-04-21.md`

## Executive Summary

The decision is to move Torghut quant authority behind bounded hot-path proof projections and to settle every
non-observe capital move through a profit cell that cites those projections.

The reason is the current system state. The Torghut pod is live and `/healthz` returns `200` in 9 ms, but `/readyz`
and `/trading/status` both timed out after eight seconds. Jangar `/ready` returns `200`, but the heavier control-plane
status route and the Torghut quant-health route both timed out after ten seconds. The database evidence is also
split: Postgres is migrated to Alembic `0029`, ClickHouse replicas are caught up, and TA data is current through the
May 4 close, but the durable empirical/profit authority tables are stale or empty. A strategy factory can produce more
candidates, but it cannot safely promote capital while the authority routes are slow and the proof records are not
settled.

The tradeoff is deliberate. I am choosing less route-time cleverness and fewer immediate capital escalations in
exchange for a system that can answer, quickly and repeatedly, "what proof is fresh, what is stale, what can trade,
and what must stay observe-only?"

## Runtime Inputs and Success Metrics

Observed runtime inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarm: `torghut-quant`
- stage: `discover`
- live collaboration channel: `general`
- NATS context soak: `workflow.general.>` fetched `0` prior teammate messages

This design succeeds when:

1. `/readyz`, `/trading/status`, Jangar quant health, and promotion checks can answer from bounded proof projections
   without scanning broad history tables or recomputing the full trading status graph.
2. Each active projection has an `evidence_epoch_id`, source watermarks, route budget result, data quality result,
   image/platform receipt, and rollback disposition.
3. Each non-observe hypothesis has exactly one active `profit_cell_settlement_id` for account, window, and stage.
4. A stale data segment, timed-out proof route, or failed deploy receipt blocks only the affected cell unless the
   failure invalidates the shared epoch.
5. Engineer and deployer stages can validate the contract with read-only route calls and database projections, not
   privileged shell access.

## Assessment Evidence

All cluster and database operations in this assessment were read-only.

### Cluster, Rollout, and Events

- `kubectl auth whoami` identified the runner as `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset, but Kubernetes API calls succeeded with the in-cluster service account.
- `kubectl get pods -n torghut -o wide` showed the main Torghut revision
  `torghut-00204-deployment-86757887d7-rg2nq` running `2/2`, and the sim revision
  `torghut-sim-00281-deployment-6474d7bf56-vqmnr` running `2/2`.
- ClickHouse, Keeper, Torghut DB, WS, TA, options catalog, options enricher, and options TA pods were running.
- `kubectl get ksvc -n torghut` was forbidden for this service account, so rollout evidence must not depend on
  Knative Service reads from architecture-stage workers.
- Recent Torghut events showed repeated rollout churn, completed migration/backfill jobs on the promoted Torghut
  digest, and a `torghut-db-1` readiness probe failure with HTTP `500`.
- Recent Jangar events showed the active Jangar pod on digest
  `sha256:4ebf9060cac6d01623a719b37286fd51fbeae95fe657cd8bc88c9b5bdf0c7c92`, plus recent Jangar DB and Redis
  readiness/liveness probe failures.
- `kubectl get agentruns -n agents` showed active Jangar and Torghut swarm runs, old failed scheduled runs, and
  active review pods, so stale stage debt is still visible in the control plane.

### Route and Control-Plane Behavior

- `curl http://torghut-00204-private.torghut.svc.cluster.local:8012/healthz`
  returned `{"status":"ok","service":"torghut"}` with HTTP `200` in `0.008804` seconds.
- `curl .../readyz` timed out after `8.002912` seconds with no body.
- `curl .../trading/status` timed out after `8.001903` seconds with no body.
- `curl http://jangar.jangar.svc.cluster.local/ready` returned HTTP `200` in `0.058375` seconds, but the payload
  reported `execution_trust.status="degraded"`, stale Jangar and Torghut stages, and collaboration runtime admission
  blocked by `runtime_kit_component_missing:nats_cli`.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` timed out after ten
  seconds.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health` timed out after ten
  seconds.
- Jangar app logs showed repeated GitHub review ingest failures for deleted or merged refs and repeated control-plane
  heartbeat read timeouts.

### Source Architecture and Test Surface

- `services/torghut/app/trading` has `123` Python modules and `85,739` total lines.
- `services/torghut/tests` has `146` Python test files.
- The largest trading modules are:
  - `app/trading/autonomy/lane.py`: `7,377` lines;
  - `app/trading/autonomy/policy_checks.py`: `6,072` lines;
  - `app/trading/research_sleeves.py`: `5,254` lines;
  - `app/trading/scheduler/pipeline.py`: `4,273` lines;
  - `app/trading/decisions.py`: `3,293` lines.
- `services/torghut/app/main.py` makes `/readyz` call `_evaluate_trading_health_payload` with the database contract,
  readiness dependency snapshot, universe dependency, alpha readiness, TCA summary, and market-context status.
- `/trading/status` builds empirical jobs, quant evidence, forecast status, Lean status, LLM evaluation, TCA, market
  context, hypothesis runtime, live-submission gate, execution metadata, and decision recency in one request.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` starts the quant runtime, reads the
  latest metrics store, and lists latest pipeline health on the route path.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` has a compact latest-metrics read model, but the latest
  pipeline-health query ranks rows with a window function. Given the ten-second timeout, this route should be treated
  as a route-budget risk until a bounded projection proves otherwise.
- Local migration graph validation could not run because the worker lacks `uv` and the Python environment lacks
  Alembic: `ModuleNotFoundError: No module named 'alembic'`.

### Database, Data Quality, Freshness, and Consistency

Postgres was queried directly through `torghut-db-app` credentials in a read-only transaction.

- PostgreSQL version: `17.0`.
- Database/user: `torghut` / `torghut_app`.
- Public table count: `69`.
- Alembic version: `0029_whitepaper_embedding_dimension_4096`.
- Largest estimated live tables:
  - `torghut_options_contract_catalog`: `2,090,007`;
  - `trade_decisions`: `147,606`;
  - `position_snapshots`: `39,696`;
  - `llm_decision_reviews`: `23,567`;
  - `executions`: `13,778`.
- Freshness samples:
  - `trade_decisions`: `147,606` rows, max `created_at=2026-05-04 17:25:57.901670+00`;
  - `executions`: `13,778` rows, max `updated_at=2026-04-03 05:32:36.212112+00`;
  - `vnext_empirical_job_runs`: `16` rows, max `updated_at=2026-03-21 09:03:22.150009+00`;
  - `vnext_completion_gate_results`: `3` rows, max `measured_at=2026-03-21 09:03:22.360697+00`;
  - `vnext_promotion_decisions`, `strategy_hypotheses`, `strategy_capital_allocations`, `autoresearch_epochs`,
    `simulation_run_progress`, and `vnext_dataset_snapshots`: `0` rows.
- Account-scoped indexes exist for executions, trade decisions, and trade cursor, but the legacy
  `uq_executions_client_order_id` index still exists. That may be acceptable in the current account mode, but it is a
  migration witness risk for multi-account execution.

ClickHouse was queried over HTTP with the Torghut ClickHouse user.

- `torghut.ta_microbars`: `1,625,888` rows, `12` symbols, `max_event_ts=2026-05-04 20:58:15.000`,
  `max_ingest_ts=2026-05-05 05:38:21.517`.
- `torghut.ta_signals`: `1,133,243` rows, `12` symbols, `max_event_ts=2026-05-04 20:58:15.000`,
  `max_ingest_ts=2026-05-05 05:38:21.517`.
- `system.replicas` showed `is_readonly=0`, `is_session_expired=0`, `absolute_delay=0`, and `queue_size=0` for
  Torghut TA tables.

Interpretation: the data plane has enough recent market data to evaluate a May 5 premarket state, and ClickHouse
replication is healthy. The profit authority plane is not equally fresh; current empirical and promotion records do
not prove a live capital move.

## Problem Statement

Torghut currently has the wrong thing on the hot path. The readiness and status routes are trying to answer
dependency health, schema health, strategy health, empirical authority, quant evidence, market context, TCA, LLM
review, and live-submission gating synchronously. That makes routes slow exactly when operators and downstream Jangar
consumers need a small, reliable answer.

The profitability problem is the same shape. Research and strategy generation can keep improving, but capital should
not move because a route managed to assemble a large payload once. Capital should move only when a compact settlement
record says the data source, runtime epoch, image receipt, post-cost evidence, and rollback path all agree.

## Alternatives Considered

### Option A: Tune Timeouts and Keep Route-Time Authority

This option raises HTTP timeouts, increases readiness cache tolerance, and adds more defensive exception handling.

Pros:

- Fastest implementation.
- Minimal schema work.
- Keeps current route payloads familiar.

Cons:

- Preserves broad route-time recomputation as the authority model.
- Makes slow dependencies harder to notice.
- Does not settle profit evidence into an auditable object.
- Fails under partial RBAC because some operators cannot read all backing resources.

Decision: rejected as the primary architecture direction.

### Option B: Prioritize Strategy Factory Throughput

This option puts the next phase into whitepaper autoresearch, MLX candidate generation, and more replay workers.

Pros:

- Directly targets the profitability objective.
- Uses existing strategy-factory and whitepaper architecture.
- Produces more candidate sleeves.

Cons:

- More candidates do not help if `/trading/status` and quant health cannot answer reliably.
- Existing empirical/profit authority rows are stale or empty.
- Stale proof can convert better research into unsafe capital promotion.

Decision: rejected for this phase.

### Option C: Hot-Path Proof Projections and Profit-Cell Settlement

This option makes a background projector compile small proof projections and makes promotion consume settled profit
cells rather than synchronous route assemblies.

Pros:

- Keeps read routes cheap and bounded.
- Gives Jangar one stable Torghut authority object.
- Degrades by hypothesis, account, source, or epoch instead of by whole service where possible.
- Makes deployers validate route budgets, image receipts, and rollback readiness before widening.
- Preserves strategy-factory upside while preventing unproved capital moves.

Cons:

- Adds additive tables or equivalent persisted read models.
- Requires a refactor of status-route authority.
- Requires careful expiry semantics so stale last-good projections cannot become false confidence.

Decision: selected.

## Decision

Adopt Option C.

The new architecture layer has three contracts.

### 1. ProofProjection

`ProofProjection` is the hot-path read model for Torghut authority. It is produced out of band by the trading
scheduler or a small projector and consumed by:

- `/readyz`;
- `/trading/status`;
- Jangar quant health;
- live-submission gates;
- deploy verification;
- promotion/capital checks.

Required fields:

- `proof_projection_id`;
- `evidence_epoch_id`;
- `producer_revision`;
- `source_watermarks` for Postgres, ClickHouse TA, market context, empirical jobs, strategy configs, and Jangar;
- `route_budget_ms`, `compile_budget_ms`, and `last_compile_duration_ms`;
- `status`: `allow`, `degrade`, `hold`, or `block`;
- `reason_codes`;
- `fresh_until`;
- `query_fuse_results`;
- `image_platform_receipt_id`;
- `schema_witness_id`;
- `rollback_readiness`.

Hot routes may return the latest projection and a bounded explanation. They must not run raw historical scans,
unbounded window queries, or full status graph recomputation.

### 2. ProfitCellSettlement

`ProfitCellSettlement` is the capital authority object for a hypothesis/account/window/stage.

Required fields:

- `profit_cell_settlement_id`;
- `hypothesis_id`;
- `account_label`;
- `window`;
- `stage`: `observe`, `probe`, `canary`, `live`, `scale`, or `quarantine`;
- `proof_projection_id`;
- `evidence_epoch_id`;
- `post_cost_pnl`;
- `drawdown`;
- `slippage`;
- `capacity`;
- `concentration`;
- `data_freshness_status`;
- `empirical_job_bundle_id`;
- `promotion_decision`;
- `rollback_signal`;
- `fresh_until`.

No non-observe stage can be active unless its profit cell cites a fresh proof projection and a current evidence
epoch. A stale projection can keep observe routes available, but it cannot promote or widen capital.

### 3. RouteFuse

`RouteFuse` is the contract that turns slow authority into an explicit status instead of a timeout.

Rules:

1. `/healthz` remains liveness only.
2. `/readyz` answers from the latest `ProofProjection`; if no projection exists, it returns `503` with
   `reason_codes=["proof_projection_missing"]`.
3. `/trading/status` returns a compact projection summary by default and exposes heavy diagnostic sections only behind
   explicit query params or a separate diagnostics route.
4. Jangar quant health consumes the same projection or a bounded Jangar mirror of it.
5. Any route that exceeds its budget emits a `route_budget_exceeded` reason in the next projection.

## Implementation Scope

Engineer stage:

1. Add the projection and settlement contracts as additive models, migrations, and typed payloads.
2. Build the Torghut projector with strict statement timeouts and bounded ClickHouse queries.
3. Refactor `/readyz` and `/trading/status` to consume the projection by default.
4. Add route-budget tests that fail when the status path reintroduces broad synchronous dependency work.
5. Add profit-cell tests for stale projection, stale empirical jobs, ClickHouse freshness, image receipt failure, and
   rollback-required paths.
6. Add a Jangar mirror or typed pull route so Jangar quant health can answer without scanning its broad pipeline
   history on the request path.

Deployer stage:

1. Verify the projector writes a fresh projection before widening traffic.
2. Verify `/readyz`, `/trading/status`, and Jangar quant health return within their route budgets for three
   consecutive samples.
3. Verify every non-observe cell cites the active projection and active evidence epoch.
4. Verify image/platform receipts cover the nodes that run Torghut live and sim.
5. Keep `TRADING_MODE=paper` or capital stage `observe` unless the settlement gates pass.

## Validation Gates

Required local/CI gates for implementation PRs:

- Torghut unit tests for projection compilation and profit-cell settlement.
- Regression test proving `/trading/status` can serve from a prebuilt projection when dependencies are slow.
- Regression test proving stale empirical/profit records block non-observe promotion.
- Migration graph check with repo-approved tooling.
- Pyright profiles required by the Torghut service instructions.
- Jangar route tests proving quant health uses the bounded projection path.

Required live validation:

- `curl /healthz` returns HTTP `200`.
- `curl /readyz` returns within `500 ms` from an existing projection or returns a bounded `503` with
  `proof_projection_missing`.
- `curl /trading/status` returns within `750 ms` for the compact response.
- Jangar quant health returns within `750 ms`.
- ClickHouse TA replica delay remains `0` or below the active projection threshold.
- Postgres projection row is fresher than its `fresh_until`.

## Rollout

1. Ship schema and write-only projector in shadow mode.
2. Mirror projection status in `/trading/status` while keeping the current heavy payload available.
3. Switch `/readyz` to projection-backed authority once three consecutive projections are fresh.
4. Switch Jangar quant health to projection-backed authority.
5. Enforce profit-cell settlement for `probe`, then `canary`, then `live`.
6. Retire broad route-time authority after deployer verifies stable route budgets.

## Rollback

Rollback is projection-first:

- stop enforcing projection-backed promotion;
- keep writing projections for audit;
- return `/readyz` to the previous dependency check path only if the old route is healthy under budget;
- force all non-observe profit cells to `observe` if projection freshness is unknown;
- keep schema additive and do not delete settlement rows during rollback.

## Risks and Open Questions

- The legacy `uq_executions_client_order_id` index may conflict with multi-account execution goals. Engineer stage
  should decide whether to remove it under a guarded migration or record why it remains valid.
- Projection freshness must avoid false confidence during market-close windows. The projection needs a market-session
  calendar and explicit "closed but expected stale" reasons.
- Jangar quant health timeout root cause is inferred from the source route shape and observed timeout, not proven by a
  database trace in this run.
- The worker could query Torghut DB and ClickHouse but could not list Knative Services or exec into pods. Deployer
  validation must stay compatible with that partial-RBAC reality.

## Handoff Contract

Engineer acceptance gates:

- A fresh `ProofProjection` exists and is served by Torghut status routes.
- A stale projection blocks non-observe `ProfitCellSettlement`.
- A route-budget regression test fails if `/trading/status` performs broad synchronous proof compilation by default.
- Jangar quant health reads bounded projection authority.

Deployer acceptance gates:

- Projection-backed `/readyz`, compact `/trading/status`, and Jangar quant health meet route budgets in-cluster.
- No live or canary capital is enabled without a fresh projection, active evidence epoch, and settled profit cell.
- Rollback returns all non-observe cells to observe without deleting audit rows.
