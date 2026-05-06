# 114. Jangar Evidence Transport Ledger And Watch Restart Circuit Breakers (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane evidence transport, resolver leases, watch restart confidence, Torghut proof-route parity,
and material-action admission.

Companion Torghut contract:

- `docs/torghut/design-system/v6/118-torghut-proof-route-parity-and-options-informed-repair-scheduler-2026-05-06.md`

Extends:

- `113-jangar-contradiction-settlement-and-profit-repair-auction-2026-05-06.md`
- `112-jangar-session-scoped-proof-settlement-and-stale-alert-netting-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting an **evidence transport ledger with resolver leases and watch restart circuit breakers** as the next
Jangar control-plane architecture step.

The last accepted design made contradictory authority first-class. The new evidence shows the layer below that still
needs to be made explicit: the transport contract for the facts themselves. At `2026-05-06T12:10Z`, Jangar `/ready`
was HTTP `200`, leader election was active, the database projection was healthy, runtime kits were healthy, NATS tooling
was present, and serving plus swarm admission passports were allowed. The `agents` deployment was `1/1` and
`agents-controllers` was `2/2`. That is the good news.

The same Jangar status reported watch reliability as `degraded`: `5` streams, `1498` events, `0` errors, and `1111`
restarts in the 15-minute window. Recent agents events also showed readiness probe timeouts and a controller HTTP `503`
probe miss. This is not a classic outage. It is a confidence problem. The control plane can serve a status document
while its watch substrate is churning enough that consumers should not treat every fresh-looking projection as equal.

Torghut exposed the matching consumer-side problem. Live `torghut-00236` had healthy Postgres, ClickHouse, Alpaca, and
a fresh 12-symbol Jangar universe, but `/readyz` and `/trading/health` were HTTP `503`. The payload said live
submission was disabled, empirical proof was degraded, alpha readiness could not fetch Jangar status because the
configured internal URL refused the connection, and quant health was not configured for the live route. Jangar's typed
quant route was reachable from the agents service for the live account, but its latest metrics were from
`2026-05-05T17:28:03.839Z` with `metricsPipelineLagSeconds=67353`. The sim account route was reachable but empty.
Torghut sim health showed the source URL as `http://jangar.jangar.svc.cluster.local/...`, while the actual serving
service in this cluster is `agents.agents.svc.cluster.local`. That is a proof-route split, not a trading signal.

The selected design requires every Jangar evidence producer to publish how the evidence was transported, how a consumer
should resolve it, which freshness clock applies, and when watch churn lowers confidence. Material actions will consume
evidence by contract id rather than raw URL strings. The tradeoff is one more contract for every important proof
surface. I accept that because a settlement ledger is only as good as the route by which its inputs and closure receipts
arrive.

## Evidence Snapshot

All checks were read-only. No Kubernetes resources, database rows, broker flags, Argo applications, or trading records
were mutated.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- Branch was `codex/swarm-torghut-quant-discover`, based on `main` at
  `8e54d72da933ef574c8da854614d36e8c58d4296`.
- `kubectl config current-context` was initially unset; I bootstrapped a local in-cluster context from the mounted
  service-account token and verified `kubectl auth whoami`.
- `deployment/agents` was `1/1` available on
  `registry.ide-newton.ts.net/lab/jangar-control-plane:856f5579@sha256:a296b3a8e23b3adeb87abb1882a1d2e26df40a98bd84c848130b457624ebda54`.
- `deployment/agents-controllers` was `2/2` available on
  `registry.ide-newton.ts.net/lab/jangar:856f5579@sha256:ddcf27ec8bc22bdef4cc53309845452a6416236b8cd83d57185b7fb252cec45c`.
- Recent agents events included `BackoffLimitExceeded` for `torghut-quant-implement-sched-t66gj-step-1-attempt-1`,
  readiness timeout for `agents-8665748649-8zkrj`, readiness timeout and HTTP `503` for
  `agents-controllers-69b9f9dd59-jcvg7`, and a readiness timeout for `agents-controllers-69b9f9dd59-7krc7`.
- Torghut live revision `torghut-00236` and sim revision `torghut-sim-00322` were running. ClickHouse, Keeper,
  Postgres, options catalog, options enricher, live TA, sim TA, websocket, Alloy, and Symphony pods were running.
- Recent Torghut events showed sim and live startup/readiness probe misses that later cleared, a successful
  `torghut-sim-runtime-ready` analysis, duplicate ClickHouse PodDisruptionBudget matches, and Keeper PDB `NoPods`.
- RBAC blocked direct database shells: `pods/exec` is forbidden in the `torghut` namespace for this service account.
  ClickHouse HTTP without credentials returned `REQUIRED_PASSWORD`. The normal verification path must therefore be
  service-owned projections, not privileged shells.

### Status, Data, And Freshness Evidence

- Jangar `/ready` returned HTTP `200` with leader election active, execution trust healthy, runtime kits healthy, NATS
  binaries present, and serving/swarm admission passports allowed.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`, `connected=true`,
  `status=healthy`, `latency_ms=4`, and Kysely migrations `28/28` with latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- The same Jangar status reported `watch_reliability.status=degraded`, `total_events=1498`, `total_errors=0`, and
  `total_restarts=1111` across `5` streams.
- Torghut `/db-check` returned HTTP `200`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`. The lineage warnings were known Alembic parent forks, not missing heads.
- Torghut live `/readyz` and `/trading/health` returned HTTP `503`. Live submission was blocked by
  `simple_submit_disabled`; alpha readiness had `hypotheses_total=3`, `promotion_eligible_total=0`,
  `rollback_required_total=3`, and Jangar status fetch failed with connection refused.
- Torghut `/trading/status` reported live build commit `61ee8f7aee31e623f93a3a1881bf2b08ae1e54c3`, active revision
  `torghut-00236`, `last_decision_at=2026-05-04T17:25:57.901670Z`, and signal continuity alert
  `cursor_ahead_of_stream`.
- Torghut `/trading/autonomy` reported stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all tied to `torghut-full-day-20260318-884bec35`.
- Jangar typed quant health for live account `PA3SX7FYNUTF`, window `15m`, was HTTP `200` with `status=ok`, but the
  latest metrics were stale by `67353` seconds.
- Jangar typed quant health for `TORGHUT_SIM`, window `15m`, was HTTP `200` with `status=degraded`,
  `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.
- `torghut-options-catalog` and `torghut-options-enricher` returned HTTP `200`; the catalog was ready but had
  `last_success_ts=null`, while the enricher had a current `last_success_ts`. Live and sim Flink TA REST endpoints each
  reported one `RUNNING` job.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database, controller, rollout, watch, workflow,
  empirical-service, runtime-admission, failure-domain, negative-evidence, and execution-trust status.
- `services/jangar/src/server/control-plane-watch-reliability.ts` already detects restart-driven degradation. It does
  not yet express per-action confidence or consumer route impact.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already names negative evidence for stale
  market context, quant alerts, readiness debt, watch reliability, and workflow failures.
- `services/torghut/app/config.py` keeps `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` and
  `TRADING_JANGAR_QUANT_HEALTH_URL` optional raw URLs. That leaves endpoint authority outside the proof contract.
- `services/torghut/app/main.py` is `4051` lines and owns `/readyz`, `/db-check`, `/trading/health`, `/trading/status`,
  `/trading/autonomy`, decisions, executions, and data projections.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns market-context observations, signal
  continuity, rejection accounting, LLM decision context, and order-submission preparation.
- Tests exist for Jangar control-plane status, watch reliability, negative evidence, Torghut DB checks, empirical jobs,
  quant health, and submission-council gates. The missing system-level test is proof-route parity across producer
  service DNS, consumer config, freshness clock, and action-class confidence.

## Problem

Jangar can now produce rich control-plane evidence, but the system does not yet prove that each consumer is reading the
same evidence through a supported route and freshness clock.

The failure mode is subtle:

1. Jangar serving can be healthy while watches restart aggressively.
2. Jangar can expose a typed quant endpoint while Torghut is configured to call another service DNS name.
3. Torghut can prove Postgres and ClickHouse are reachable while live status cannot prove Jangar dependency quorum.
4. Direct database access can be rightly blocked by RBAC, making service-owned projections the only portable evidence
   path.
5. Repair auctions can rank work, but a closure receipt is weak if its route is not contractually resolvable.

The architecture gap is transport authority. Current reducers tell us whether facts are good, stale, blocked, or
contradictory. They do not tell us whether the facts moved through an approved route, whether a consumer was using the
right endpoint identity, or whether watch churn should lower the confidence of route-adjacent projections.

## Alternatives Considered

### Option A: Patch The Misconfigured Torghut URLs

Pros:

- Fastest visible fix for `jangar_status_fetch_failed` and `quant_health_fetch_failed`.
- Low implementation cost.
- Useful as an immediate deployer task.

Cons:

- Leaves the same failure mode open for the next endpoint, namespace, account, or sim/live split.
- Does not account for watch restart confidence.
- Does not give Jangar a way to reject closure receipts from unsupported routes.

Decision: reject as the architecture. Keep it as the first repair bid.

### Option B: Add Route Debt To The Existing Contradiction Settlement

Pros:

- Reuses the accepted settlement object.
- Makes material-action holds visible quickly.
- Avoids another projection name.

Cons:

- Settlement is a verdict layer, not a transport registry.
- It would bury route resolution details inside action outcomes instead of making them reusable by all producers.
- It does not give Torghut a stable contract id to consume before building readiness and scheduler records.

Decision: reject as the primary layer. Settlement should consume route evidence, not own it.

### Option C: Evidence Transport Ledger With Resolver Leases And Watch Restart Circuit Breakers

Pros:

- Makes evidence route, audience, freshness clock, credential class, and fallback path explicit.
- Lets Jangar downgrade confidence when watches restart without blocking read-only serving.
- Gives Torghut a contract id instead of a raw URL for dependency quorum, quant health, empirical proof, market context,
  options data, and closure receipts.
- Creates one portable verification path when direct DB shells are unavailable by design.
- Reduces manual interpretation during market sessions and rollout transitions.

Cons:

- Adds a new contract every important evidence producer must publish.
- Requires careful migration so existing routes continue to work while consumers adopt contract ids.
- Can be noisy if every minor route check becomes a material-action hold.

Decision: select Option C.

## Architecture

Jangar adds three projections.

```text
control_plane_evidence_transport_contract
  contract_id
  producer_surface              # jangar_status, quant_health, empirical_jobs, market_context,
                                # options_catalog, options_enricher, gitops_convergence, closure_receipt
  audience                      # jangar, torghut_live, torghut_sim, deployer, engineer
  service_identity              # namespace/service/path or external authority
  resolved_endpoint
  route_owner
  credential_class              # public_cluster, service_account, app_secret, privileged_shell_unavailable
  freshness_clock               # producer_observed_at, data_as_of, watch_event_at, market_session
  max_freshness_seconds
  payload_schema_version
  fallback_contract_id
  last_verified_at
  verification_status           # ok, stale, auth_required, forbidden, timeout, wrong_service, unknown
```

```text
evidence_endpoint_resolver_lease
  lease_id
  contract_id
  consumer_surface
  resolved_at
  expires_at
  decision                      # allow, allow_stale_readonly, repair_only, hold_material, block
  decision_reason_codes
  observed_http_status
  observed_payload_fingerprint
  consumer_config_ref
```

```text
watch_restart_circuit_breaker
  breaker_id
  namespace
  resource
  window_minutes
  restart_count
  error_count
  affected_contract_ids
  action_confidence             # normal, degraded_readonly, repair_only, hold_material
  reset_condition
```

Rules:

- `serve_readonly` stays allowed when serving, database, runtime kit, and resolver contracts are healthy or stale only
  for non-material consumers.
- `dispatch_repair` is allowed when the target repair closes a route contract, does not require live capital, and has a
  max notional of `0`.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, and `live_micro_canary` are held when their required
  transport contract is `wrong_service`, `forbidden`, `timeout`, `auth_required`, or materially stale.
- Watch restarts degrade confidence for resources they watch. They do not by themselves block read-only serving, but
  they hold rollout widening when restart counts exceed the configured circuit-breaker threshold.
- Direct privileged shell checks are never required for routine material-action admission. If RBAC forbids direct DB
  access, the contract records `privileged_shell_unavailable` and requires a service-owned projection instead.

## Implementation Scope

Jangar engineer scope:

- Add a pure transport-contract reducer that normalizes configured Jangar, Torghut, quant, empirical, market-context,
  and options evidence endpoints into `control_plane_evidence_transport_contract`.
- Add resolver leases for the consumers Jangar already knows: Jangar status, Torghut live, Torghut sim, deployer
  verification, and engineer repair jobs.
- Extend watch-reliability output with affected route contracts and action confidence.
- Extend `/api/agents/control-plane/status` with current transport contracts, resolver leases, and watch circuit-breaker
  state.
- Feed transport decisions into contradiction settlement and negative evidence without replacing those layers.
- Add tests for wrong service DNS, stale quant route, forbidden DB shell with healthy service projection, and
  restart-only watch degradation.

Torghut engineer scope:

- Replace raw internal Jangar URL consumption with contract-id based resolver configuration for dependency quorum and
  quant health.
- Emit the consumed transport contract ids in `/readyz`, `/trading/health`, `/trading/status`, and scheduler
  observation records.
- Treat `wrong_service`, `timeout`, or materially stale route contracts as repair bids, not capital allows.
- Keep live notional at `0` until the route contracts for dependency quorum, quant health, empirical proof, market
  context, and broker reconciliation are all current for the target account/strategy/window.

## Validation Gates

Engineer acceptance:

- Unit tests prove `http://jangar.jangar.svc.cluster.local` is classified as `wrong_service` when the active service is
  `agents.agents.svc.cluster.local`.
- Unit tests prove watch restarts with zero errors produce `degraded_readonly` for serving and `hold_material` for
  rollout widening only when the affected watched resources are required by that action.
- Unit tests prove RBAC-forbidden database shell access does not fail a contract when `/db-check` or Jangar DB status is
  healthy and current.
- Route tests prove `/api/agents/control-plane/status` exposes contract ids, resolver decisions, verification status,
  freshness clocks, and affected action classes.
- Torghut tests prove dependency-quorum and quant-health consumers record transport contract ids and block paper/live
  preparation on `wrong_service`, `timeout`, or materially stale contracts.

Deployer acceptance:

- Before widening Jangar or Torghut, the deployer can show current resolver leases for Jangar status, quant health,
  empirical proof, and rollout evidence.
- Before paper capital, the deployer can show all required route contracts are `ok` for the exact account, strategy,
  window, and market session.
- If direct DB access is forbidden, the deployer can cite the corresponding service-owned DB projection and the
  `privileged_shell_unavailable` contract status instead of requesting broader RBAC.

Profit acceptance:

- Within two market sessions of implementation, Torghut should retire the `wrong_service` Jangar status fetch and
  quant-health fetch failures or publish closure debt explaining why the route remains intentionally disabled.
- The first repair auction after rollout should include at least one route-parity bid and one profit-proof freshness bid,
  with the route-parity bid carrying `max_notional=0`.
- No paper or live capital can be admitted from a route that lacks a current resolver lease.

## Rollout Plan

1. Ship transport contracts in shadow mode inside Jangar status.
2. Add resolver leases for Jangar's own status and typed quant-health routes.
3. Teach Torghut live and sim health to echo consumed contract ids while keeping existing URLs as fallback.
4. Wire watch restart circuit breakers into deploy-widen and merge-ready settlement only.
5. Enforce route-contract presence for paper canary after seven consecutive healthy contract epochs.
6. Enforce route-contract freshness for live micro-canary only after paper settlement, broker reconciliation, TCA, and
   rollback rehearsal are already current.

## Rollback Plan

- Disable transport-contract enforcement with a feature flag and continue using existing status URLs and submission
  gates.
- Keep writing shadow contracts during rollback for comparison.
- If resolver leases are noisy, enforce only `wrong_service`, `forbidden`, and `timeout` while leaving staleness as
  warning.
- If watch restart circuit breakers over-hold rollout widening, fall back to the existing watch-reliability status while
  retaining route contracts.

## Risks

- The transport ledger can become another broad inventory. Mitigation: only material evidence surfaces get contracts,
  and every contract must name audience, freshness clock, and action impact.
- Watch restart degradation can be too conservative. Mitigation: classify by affected contract ids instead of global
  watch status.
- Contract ids can lag actual deployment changes. Mitigation: leases expire quickly and consumers must show the
  observed endpoint and payload fingerprint.
- A route can be healthy but semantically stale. Mitigation: route verification and data freshness are separate fields,
  and capital requires both.

## Handoff

Engineer stage should implement this as data and reducers first. The first useful slice is Jangar status transport
contracts plus Torghut echoing consumed contract ids for dependency quorum and quant health. No broker or order
submission behavior should change in the first slice.

Deployer stage should stop treating pod availability as proof-route health. The required gate before any material
action is a current resolver lease for the evidence contract that action consumes. If the database shell remains
forbidden, that is acceptable when the service-owned DB projection is current and the contract records the RBAC boundary.
