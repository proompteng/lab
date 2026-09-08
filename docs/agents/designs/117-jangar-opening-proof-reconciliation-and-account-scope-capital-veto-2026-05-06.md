# 117. Jangar Opening Proof Reconciliation And Account-Scope Capital Veto (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar quant proof authority, opening-session admission, account-scoped freshness, stale alert settlement,
controller rollout evidence, and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/121-torghut-opening-bell-proof-ladder-and-account-scoped-alpha-reentry-2026-05-06.md`

Extends:

- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`
- `114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`

## Decision

I am selecting an **opening proof reconciliation layer with account-scoped capital vetoes**.

The current cluster is no longer in the earlier hard-infra failure posture. The agents service is routable, the
agents-controller deployment is `2/2`, Jangar is serving, Torghut live and sim revisions are running, Torghut Postgres
schema health is current, and the sim route has recovered from the earlier image pull failure. That is a better base.

It is still not safe to infer capital readiness from aggregate health. At `2026-05-06T13:12Z`, Jangar's aggregate
Torghut quant route for `window=1d` reported `latestMetricsCount=540`, `latestMetricsUpdatedAt=2026-05-06T13:12:35Z`,
and `metricsPipelineLagSeconds=5`. The same route scoped to live account `PA3SX7FYNUTF` reported
`latestMetricsCount=108`, but `latestMetricsUpdatedAt=2026-05-05T17:28:44Z` and `metricsPipelineLagSeconds=71036`.
The account-scoped route still returned `status=ok` because the missing-update alarm is market-hours sensitive and the
sample was pre-open. That is the dangerous split: aggregate proof is fresh while the account proof that would govern
capital is stale.

The rest of the evidence points the same way. Jangar `/api/torghut/ta/latest?symbol=AAPL` returned a latest signal from
`2026-05-04 20:19:07`, while the ClickHouse guardrails exporter showed table-wide max event timestamps near the
current sample. Jangar market-context health for `AAPL` was degraded because technicals, fundamentals, news, and regime
were stale. Torghut `/trading/status` had all three hypotheses in `shadow` or `blocked`, zero promotion eligible, and
three rollback required. Torghut `/trading/health` returned HTTP `503` because live submission is disabled. Jangar
still held `50` open account-scoped quant alerts for `PA3SX7FYNUTF`.

The selected design makes Jangar reconcile aggregate, account, symbol, alert, and watch evidence into one opening proof
epoch before any material action. Aggregate proof can keep dashboards and read-only observation green. It cannot unlock
paper or live capital unless the account, hypothesis, window, and symbol proof set also clears. The tradeoff is a
stricter pre-open hold, but that is exactly where the system needs discipline: the first 15 minutes of the session
should collect and settle proof, not turn stale account data into capital authority.

## Evidence Snapshot

All checks were read-only. I did not mutate Kubernetes resources, database records, Argo applications, broker state, or
trading flags.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- The workspace was on `codex/swarm-torghut-quant-discover`, clean and equal to `origin/main`.
- `kubectl config current-context` was initially unset; I established the local in-cluster context from the mounted
  service account before continuing read-only cluster checks.
- `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`.
- Recent agents events still showed readiness probe timeouts on `agents`, `agents-controllers-59ff4dd879-7tk66`, and
  `agents-controllers-59ff4dd879-8lkhp`, so the status surface needs to remember transient probe debt even when the
  deployment is currently available.
- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` returned dependency quorum `allow` with healthy
  `control_runtime`, `dependency_quorum`, `freshness_authority`, `evidence_authority`, `market_data_context`, and
  `watch_stream` segments.
- Jangar pods were running, including `jangar-f8c6b9bd9-nw52c`, `jangar-db-1`, Redis, Bumba, Open WebUI, Alloy, and
  Symphony. Jangar `/health` returned `status=ok`.
- Torghut live revision `torghut-00237` and sim revision `torghut-sim-00326` were running. ClickHouse replicas, Keeper,
  Postgres, live TA, sim TA, options catalog, options enricher, options TA, websocket, guardrail exporters, Alloy, and
  Symphony pods were running.
- Recent Torghut events showed `torghut-sim-runtime-ready` analysis succeeded for the new sim revision, while startup
  probes and readiness probes had transient failures during rollout replacement.
- This service account could list pods, services, endpoints, deployments, and events, but could not list Knative
  services or StatefulSets in the checked namespaces. It also could not exec into Postgres or ClickHouse pods.

### Database, Data, And Freshness Evidence

- Torghut `/db-check` returned `ok=true`, `schema_current=true`, `schema_graph_branch_count=1`, and
  `schema_graph_branch_tolerance=1`.
- The same `/db-check` retained lineage warnings for two known parent forks:
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Direct `kubectl cnpg psql` and direct ClickHouse `kubectl exec` were blocked by RBAC with `pods/exec` forbidden. The
  database assessment therefore uses service-owned health projections and exporters.
- The ClickHouse guardrails exporter returned `torghut_clickhouse_guardrails_last_scrape_success 1.0`; both replicas
  reported table-wide `ta_signals` and `ta_microbars` max timestamps near the current sample.
- The same exporter showed accumulated freshness fallback debt: `ta_signals=1` and `ta_microbars=198`, with low-memory
  mode currently `0`.
- Jangar `GET /api/torghut/ta/latest?symbol=AAPL` returned bars and signals from `2026-05-04 20:19:07`, showing symbol
  freshness can diverge from table-wide freshness.
- Jangar market-context health for `AAPL` was degraded. Technicals, fundamentals, news, and regime were stale, with
  `bundleFreshnessSeconds=147131` and `bundleQualityScore=0.4575`.
- Jangar aggregate quant health for `window=1d` was fresh, but `stageScopeOmitted=true` because account and window
  scope were incomplete.
- Jangar live-account quant health for `PA3SX7FYNUTF` was stale by roughly `71036` seconds for `window=1d` and
  `71076` seconds for `window=15m`, despite returning `status=ok`.
- Jangar open account-scoped quant alerts for `PA3SX7FYNUTF` totaled `50`, mostly critical
  `metrics_pipeline_lag_seconds` alerts with stale observed windows.
- Torghut `/trading/autonomy` reported stale empirical jobs for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all tied to `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.
- Torghut recent decisions returned only stale rejected rows from `2026-05-04T17:25Z`.

### Source Evidence

- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` correctly exposes aggregate and scoped
  quant health, but the route can return `status=ok` for stale account proof before market hours.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` owns the latest-store and pipeline-health projections.
  It has the data model needed for account/window reconciliation, but not a first-class opening proof epoch.
- `services/jangar/src/server/torghut-quant-runtime.ts` computes frames and alerts and already distinguishes market
  hours for freshness alarms. The missing concept is pre-open capital readiness.
- `services/jangar/src/routes/ready.test.ts` covers runtime-kit and controller readiness debt. It does not cover a
  false-green aggregate quant route masking stale account-scoped proof.
- `services/torghut/app/main.py` is `4051` lines and combines readiness, health, status, autonomy, decisions, and
  execution projections.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and builds live submission gates from
  dependency quorum, empirical jobs, DSPy runtime, quant health, market context, toggle parity, and certificate
  evidence.
- Torghut has focused tests for submission gates, market context, hypotheses, empirical jobs, quant evidence, and API
  health. The missing system test is the cross-plane case where aggregate quant proof is fresh, account proof is stale,
  symbol proof is stale, and capital remains blocked.

## Problem

Jangar currently has enough information to show the contradiction, but not enough structure to prevent the wrong
operator conclusion.

The aggregate route answers: "the quant latest store is fresh." The account route answers: "the account has latest
metrics, and because the market is not open yet, the missing-update alarm is not active." The symbol route answers:
"AAPL is stale." Alerts answer: "there are unresolved scoped lag alerts." Torghut answers: "no hypothesis can promote
and live submission is disabled."

Those facts are all true. They should not produce a green capital interpretation.

The opening session is the highest-leverage moment to fix this. Before the market opens, the system should reconcile
proof surfaces by account, strategy, window, hypothesis, and universe. At the open, the first capital decision should
consume a fresh reconciliation epoch. If account proof is stale, symbol proof is stale, or stale alerts are unresolved,
the only allowed actions are read-only observation and zero-notional repair.

## Alternatives Considered

### Option A: Trust Aggregate Quant Freshness Until Market Hours

Pros:

- Keeps the current route behavior simple.
- Avoids false alarms before 09:30 ET.
- Lets aggregate dashboards remain green when the materializer is running.

Cons:

- Allows a fresh aggregate latest store to mask stale account-scoped capital proof.
- Gives deployers no explicit warning that `stageScopeOmitted=true` is not capital authority.
- Does not reconcile symbol freshness, market-context staleness, or open scoped alerts.

Decision: reject. Aggregate health is useful for observability, not capital admission.

### Option B: Freeze All Material Actions Until Every Data Surface Is Perfect

Pros:

- Safest capital posture.
- Easy to reason about during incidents.
- Avoids edge cases around stale alerts and closed-market staleness.

Cons:

- Blocks the zero-notional repair work needed to clear stale empirical, quant, and market-context proof.
- Treats stale account proof the same as a controller outage.
- Reduces profitability by starving the repair lanes that produce fresh evidence.

Decision: reject. Repair should continue under strict no-capital bounds.

### Option C: Opening Proof Reconciliation With Account-Scoped Capital Vetoes

Pros:

- Keeps aggregate health available while preventing it from authorizing capital.
- Creates an explicit pre-open and opening-session proof epoch.
- Allows repair-only actions when account, symbol, or alert proof is stale.
- Gives Torghut one Jangar-owned proof reconciliation receipt to consume before paper or live activation.
- Makes false-green states testable.

Cons:

- Adds another reducer and payload to status.
- Requires account, strategy, and universe scoping discipline.
- Can delay paper activation when proof is stale but the route is otherwise healthy.

Decision: select Option C.

## Architecture

Jangar adds an opening proof reconciliation projection:

```text
opening_proof_reconciliation_epoch
  epoch_id
  generated_at
  expires_at
  market_session
  session_phase                  # pre_open, opening_auction, open_collect, regular, closed
  account
  strategy_id
  hypothesis_id
  window
  universe_ref
  aggregate_quant_ref
  account_quant_ref
  symbol_freshness_refs
  market_context_refs
  alert_refs
  watch_quiescence_refs
  controller_witness_refs
  aggregate_status               # fresh, stale, empty, unknown
  account_status                 # fresh, stale, empty, unknown
  symbol_status                  # fresh, partial, stale, empty
  alert_status                   # none, stale_open, fresh_open, unresolved
  reconciliation_status          # allow_observe, allow_repair, hold_capital, block
  false_green_reasons
  required_repairs
  max_notional
```

Rules:

- Aggregate quant health with `stageScopeOmitted=true` can only support `allow_observe`.
- Account-scoped quant proof is stale when `latestMetricsUpdatedAt` is older than the configured pre-open freshness
  budget, even if the market-hours missing-update alarm is inactive.
- Symbol freshness must be evaluated for the active hypothesis universe, not from table-wide max timestamps.
- Open alerts are netted only when the epoch cites fresher scoped proof that supersedes the alert's observed window.
- `paper_canary`, `live_micro_canary`, and `live_scale` require `reconciliation_status=allow_observe` plus a matching
  Torghut activation receipt; otherwise they remain `hold_capital` or `block`.
- `dispatch_repair` is allowed with max notional `0` when the epoch names a concrete repair and watch/controller
  evidence is current enough to run the repair.

## Profit Hypotheses And Guardrails

- Hypothesis 1: account-scoped opening proof will reduce false capital readiness caused by aggregate route freshness.
  Success means no paper or live activation can cite an aggregate-only quant route.
- Hypothesis 2: pre-open symbol and market-context reconciliation will improve paper candidate quality. Success means
  H-REV and H-CONT cannot enter paper canary with stale AAPL-style symbol proof or stale context domains.
- Hypothesis 3: stale alert netting will reduce alert noise without hiding current capital risk. Success means alerts
  are closed only when a newer account/window proof ref supersedes their observed window.
- Guardrail: reconciliation can never raise max notional above `0`; it only authorizes observation or repair. Capital
  notional is set by Torghut activation receipts after consuming the epoch.

## Implementation Scope

Jangar engineer scope:

- Add an opening proof reconciliation builder that consumes quant latest-store status, pipeline health, symbol latest
  status, market context, open alerts, watch quiescence, and controller witness receipts.
- Expose the current epoch in `/api/agents/control-plane/status?namespace=agents` and the typed Torghut quant health
  route as additive fields.
- Add tests for aggregate-fresh/account-stale, aggregate-fresh/symbol-stale, stale alerts superseded by newer proof,
  pre-open stale account proof, and repair-only admission.
- Keep the first release shadow-only for status and audit.

Torghut engineer scope:

- Consume the Jangar epoch in the companion opening-bell proof ladder.
- Treat aggregate-only proof as observe-only.
- Require an epoch id in any paper or live activation receipt.

Deployer scope:

- Do not widen paper or live capital unless the active epoch id is present in the release handoff.
- Verify the epoch reports account-scoped freshness for `PA3SX7FYNUTF` and the targeted hypothesis windows.
- Keep live submission disabled while `reconciliation_status` is `hold_capital` or `block`.

## Validation Gates

- Unit: aggregate `latestMetricsCount > 0` with account lag above the pre-open budget produces
  `reconciliation_status=allow_repair` and max notional `0`.
- Unit: `stageScopeOmitted=true` can never produce capital authority.
- Unit: stale symbol latest proof blocks H-CONT/H-REV paper canary even when table-wide ClickHouse freshness is current.
- Unit: stale open alerts remain blocking unless a newer account/window proof ref supersedes them.
- Integration: `/api/agents/control-plane/status?namespace=agents` includes an opening proof epoch with account,
  window, status, false-green reasons, expiry, and required repairs.
- Runtime: pre-open sample for `PA3SX7FYNUTF` reports account-scoped proof freshness and no aggregate-only capital
  authority.
- Runtime: Torghut `/trading/status` and `/trading/health` cite the Jangar epoch before any non-observe activation.

## Rollout Plan

1. Add the builder and tests with enforcement disabled.
2. Emit the epoch in status as shadow-only evidence.
3. Record NATS/Jangar handoff updates that cite the epoch id and current reconciliation status.
4. Teach Torghut to consume the epoch but keep max notional `0`.
5. Enable repair-only enforcement for aggregate-fresh/account-stale false-green states.
6. Enable paper-canary enforcement after at least two sessions prove no false positives.

## Rollback Plan

- If the builder is noisy, remove it from action SLO decisions while keeping the payload for diagnosis.
- If pre-open freshness thresholds are too strict, widen the pre-open budget but keep aggregate-only proof at
  observe-only.
- If alert netting is wrong, disable netting and keep stale alerts as blockers until manually resolved by newer proof.
- If Torghut cannot consume the epoch, keep Torghut capital at shadow/observe and use existing live submission gates.

## Risks

- Account labels can drift. Mitigation: the epoch must include account and broker refs and reject ambiguous labels.
- Closed-market staleness can be misclassified. Mitigation: pre-open budgets are separate from market-hours alarms.
- Aggregate dashboards may look worse when scoped evidence is shown beside them. That is intentional; aggregate health
  is not capital health.
- Too much repair-only traffic can create controller pressure. Mitigation: use action SLO budgets and query budgets
  from the earlier Jangar contracts.

## Handoff

Engineer acceptance:

- Implement the opening proof reconciliation builder and tests.
- Prove aggregate-only proof cannot authorize paper or live capital.
- Prove account-scoped stale proof, stale symbol proof, and unresolved alerts produce repair-only or hold-capital
  outcomes.

Deployer acceptance:

- Before any paper or live widening, capture the active epoch id, expiry, account, strategy, window, and
  reconciliation status.
- Confirm Torghut activation receipts cite the epoch id.
- Keep rollback target as observe/shadow with max notional `0` until account-scoped proof is fresh.
