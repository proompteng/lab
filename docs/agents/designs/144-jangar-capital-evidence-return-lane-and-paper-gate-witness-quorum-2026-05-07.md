# 144. Jangar Capital Evidence Return Lane And Paper Gate Witness Quorum (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane capital evidence return, Torghut paper/live witness quorum, safer rollout behavior,
validation, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/148-torghut-profit-evidence-reactivation-scheduler-and-paper-gate-receipts-2026-05-07.md`

Extends:

- `143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md`
- `142-jangar-repair-dividend-handoff-gates-and-actuation-contracts-2026-05-07.md`
- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md`

## Decision

I am selecting **a Jangar capital evidence return lane with a paper gate witness quorum** as the next architecture
contract.

The control plane has recovered enough that the next risk is not basic Jangar availability. At
`2026-05-07T11:27Z`, `deployment/agents-controllers` was `2/2` available, `deployment/jangar` was `1/1` available,
Jangar leader election was healthy, controller rollout authority was healthy, database migration consistency was
healthy, and watch reliability was healthy with `779` events, `0` errors, and `0` restarts in the current 15 minute
window. That is a material improvement from the May 5 degraded rollout evidence.

The remaining failure is a capital evidence return failure. Jangar can see enough to allow observe and bounded repair,
but it still holds paper and live action because Torghut consumer evidence is missing or degraded. The same status
payload reported forecast service `degraded` with `registry_empty`, jobs `healthy`, and Torghut capital receipts that
held `paper_canary`, held `live_micro_canary`, and blocked `live_scale`. Torghut confirmed the reason: `/healthz`
served `ok`, while `/db-check` timed out, `/trading/health` returned `status=degraded`, the proof floor was
`repair_only`, live submission was blocked by `simple_submit_disabled`, market context was stale, execution TCA was
last computed on `2026-04-02T20:59:45.136640Z`, and zero hypotheses were promotion eligible.

The decision is to make Jangar the explicit consumer of Torghut capital evidence returns, not just a passive reader of
`/trading/status`. Jangar should accept only typed, fresh, hash-addressed Torghut receipts for paper and live gates:
proof floor, stale-proof repair exchange, TCA renewal, market-context freshness, forecast registry authority, quant
ingestion, hypothesis promotion certificates, and paper settlement. If any required receipt is absent, stale, or only
snapshot-escrowed, Jangar can allow observe and zero-notional repair but must not allow paper or live capital.

The tradeoff is that paper trading remains closed until Torghut emits a complete return bundle. I accept that. The
current empirical jobs are fresh, but without current TCA, market context, forecast authority, and promotion
certificates, paper orders would generate noisy evidence rather than a credible path to live profit.

## Runtime Objective And Success Metrics

Success means:

- Jangar serves read-only and observe traffic when controller rollout, database projection, watch reliability, runtime
  kits, and route-stability escrow are healthy.
- Jangar publishes a `torghut_capital_witness_quorum` for each account, market window, and Torghut revision.
- The witness quorum distinguishes `observe`, `zero_notional_repair`, `paper_canary`, `live_micro_canary`, and
  `live_scale`.
- Observe and zero-notional repair can use route-stable snapshot escrow.
- Paper and live require live Jangar route stability plus current Torghut receipts.
- Empirical jobs alone never authorize paper or live action.
- Forecast registry empty, stale TCA, stale market context, quant ingestion lag, missing promotion certificates, and
  disabled submit each map to explicit blocking reasons and required repairs.
- Scheduled runners can cite the witness quorum as the authoritative capital reason instead of rejoining several
  Torghut and Jangar surfaces by hand.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, trading flags, GitOps resources, or empirical artifacts.

### Cluster And Rollout Evidence

- The in-cluster identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl get deploy -n agents` showed `agents` `1/1`, `agents-alloy` `1/1`, and `agents-controllers` `2/2`.
- `kubectl get deploy -n jangar` showed `jangar` `1/1`, `bumba` `1/1`, `jangar-alloy` `1/1`, `symphony` `1/1`, and
  `symphony-jangar` `1/1`.
- `kubectl get deploy -n torghut` showed current live and sim Knative backing deployments available:
  `torghut-00254-deployment` `1/1` and `torghut-sim-00354-deployment` `1/1`.
- Torghut database, ClickHouse, Keeper, TA, sim TA, options, websocket, guardrail exporter, Alloy, and Symphony pods
  were running or completed as expected.
- `kubectl get ksvc -n torghut` was forbidden for this service account, so deployer verification must continue using
  allowed deployment, pod, event, route, and typed status surfaces unless RBAC is widened.
- Recent Torghut events still showed startup readiness timeouts during revision replacement, `LatestReadyFailed` for
  `torghut-sim-00354` before it became available, repeated ClickHouse `MultiplePodDisruptionBudgets` warnings, and
  `torghut-keeper` `NoPods` warnings.
- Recent Agents events showed earlier readiness timeouts on old `agents` and `agents-controllers` pods, then recovery
  to the current healthy rollout.

### Jangar Status Evidence

- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` returned HTTP 200.
- Jangar leader election was enabled, required, and currently leader-held.
- `agents-controller` and `supporting-controller` were healthy from the available `agents-controllers` rollout.
- `orchestration-controller`, workflow runtime, and job runtime had fresh heartbeat authority from
  `agents-controllers-644fcf9dd6-s9jls`.
- Database projection was healthy with `connected=true`, `latency_ms=516`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`, and latest applied migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was healthy over a 15 minute window with `2` observed streams, `779` total events, `0` errors, and
  `0` restarts.
- Execution trust was healthy.
- Material action receipts allowed `serve_readonly`, `dispatch_repair`, `deploy_widen`, `merge_ready`, and
  `torghut_observe`, but downgraded `dispatch_normal` to `repair_only`, held `paper_canary`, held
  `live_micro_canary`, and blocked `live_scale`.
- Paper and live receipts named missing Torghut consumer evidence and degraded forecast service as required repairs.

### Torghut Evidence

- `GET http://torghut.torghut.svc.cluster.local/healthz` returned `{"status":"ok","service":"torghut"}`.
- `GET http://torghut.torghut.svc.cluster.local/db-check` timed out after 8 seconds with no response.
- `GET http://torghut.torghut.svc.cluster.local/trading/health` returned `status=degraded`.
- Runtime dependency details reported Postgres `ok`, ClickHouse `ok`, Alpaca `ok`, Jangar universe `ok` with `12`
  symbols, empirical jobs `healthy`, and quant evidence non-blocking.
- Live submission gate was `allowed=false`, `reason=simple_submit_disabled`, and `capital_stage=shadow`.
- Profitability proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and
  `max_notional=0`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`,
  and `simple_submit_disabled`.
- Execution TCA had `13,775` orders, average absolute slippage about `568.61` bps, an `8` bps slippage guardrail, and
  last computed timestamp `2026-04-02T20:59:45.136640Z`.
- Quant latest metrics were fresh enough for the latest-store check: `latestMetricsUpdatedAt=2026-05-07T11:25:11.400Z`,
  `latestMetricsCount=144`, and pipeline lag about `153` seconds. The stage array was empty, so stage-level proof was
  not yet carrying the same authority as latest metrics.
- Jangar market-context health timed out after 8 seconds, matching Torghut's `market_context_stale` capital hold.
- Forecast service was `degraded`, `authority=blocked`, and `message=registry_empty`.
- Empirical jobs were fresh and truthful for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` on dataset snapshot `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Alpha readiness had `3` hypotheses, `1` blocked, `2` shadow, `0` promotion eligible, and `3` rollback required.

### Database And Data Evidence

- Direct CNPG inspection was blocked: `kubectl cnpg psql -n torghut torghut-db -- -c select now();` failed because
  this service account cannot create `pods/exec` in namespace `torghut`.
- Direct ClickHouse HTTP queries were blocked by authentication: unauthenticated `SELECT now()` and `SHOW DATABASES`
  returned `REQUIRED_PASSWORD`.
- The database assessment therefore relies on typed runtime surfaces plus schema/source evidence. That is acceptable
  for the design because the normal verifier path must work without privileged database shells.
- The data-quality contradiction is concrete: typed dependency checks can say Postgres and ClickHouse are `ok` while
  `/db-check` times out and capital proof remains stale. The witness quorum must treat typed data receipts as the
  authority for capital, not raw database reachability.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the current aggregation boundary for controller, runtime,
  database, watch, execution trust, and action receipt evidence.
- `services/jangar/src/server/control-plane-empirical-services.ts` reads Torghut `/trading/status` and reduces
  forecast, LEAN, and empirical job status into Jangar's control-plane status.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already maps Torghut readiness, market
  context, quant alerts, empirical jobs, and rollout ambiguity into material action decisions.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already includes empirical service status and
  Torghut capital clock references in material action receipts.
- The missing source boundary is not another general status route. It is a typed capital evidence return reducer with
  fixture coverage that refuses to turn fresh empirical jobs into paper authority when TCA, market context, forecast,
  or promotion certificates are missing.

## Problem

Jangar now has enough control-plane health to act, but the current Torghut evidence is not shaped into a complete
return bundle that Jangar can safely use for paper and live admission.

The failure modes are:

1. Empirical jobs are healthy, but the capital gate remains held because the empirical facts do not settle TCA,
   market-context freshness, forecast authority, or hypothesis promotion.
2. Jangar can see Torghut degradation, but the reason is spread across `/trading/status`, `/trading/health`, quant
   health, market-context health, and material action receipts.
3. `/db-check` can time out even while typed dependency checks report Postgres and ClickHouse `ok`; capital authority
   needs typed data receipts rather than raw reachability.
4. Snapshot escrow is appropriate for observe and repair, but paper and live need a live route and current Torghut
   proof receipts.
5. Least-privilege verification cannot depend on direct database shell or ClickHouse credentials.

## Alternatives Considered

### Option A: Let Jangar Continue Reading Torghut Status Opportunistically

Pros:

- Minimal implementation.
- Keeps current control-plane status shape.
- Avoids new receipt schemas.

Cons:

- Keeps capital evidence spread across several surfaces.
- Does not produce a durable witness that scheduled runners and deployers can cite.
- Risks overvaluing fresh empirical jobs while stale TCA and market context still block capital.

Decision: reject.

### Option B: Move Paper And Live Capital Authority Entirely Into Torghut

Pros:

- Torghut is closest to trading state.
- Reduces Jangar coupling to trading-specific proof dimensions.
- Makes local trading tests simpler.

Cons:

- Loses the cross-plane rollout and action SLO guardrails Jangar already owns.
- Weakens route-stability and controller-witness gates before material action.
- Forces deployer lanes to reconcile Jangar and Torghut after the fact.

Decision: reject.

### Option C: Add A Jangar Capital Evidence Return Lane

Pros:

- Gives Jangar one typed witness for Torghut paper and live capital gates.
- Preserves Torghut ownership of trading proof while preserving Jangar ownership of material action admission.
- Turns stale proof into explicit required repairs.
- Supports least-privilege validation through route payloads and Kubernetes object evidence.
- Gives engineer and deployer stages concrete acceptance gates.

Cons:

- Requires a new reducer and schema in Jangar.
- Requires Torghut to publish stable receipt references rather than only nested status payloads.
- Keeps paper closed until the full return bundle is present.

Decision: select Option C.

## Architecture

Jangar adds a capital evidence return lane keyed by namespace, account, Torghut revision, and market window.

```text
torghut_capital_evidence_return
  return_id
  generated_at
  fresh_until
  namespace
  account_label
  torghut_revision
  market_window
  jangar_route_state
  torghut_receipts[]
  missing_receipts[]
  stale_receipts[]
  paper_gate
  live_micro_gate
  live_scale_gate
  rollback_target
```

Each Torghut receipt is typed and hash-addressed.

```text
torghut_capital_receipt_ref
  receipt_type
  receipt_id
  source_url
  content_hash
  generated_at
  fresh_until
  decision
  reason_codes[]
  required_repairs[]
```

Required receipt types:

- `profitability_proof_floor`
- `stale_proof_repair_exchange`
- `execution_tca_renewal`
- `market_context_freshness`
- `forecast_registry_authority`
- `quant_ingestion_window`
- `hypothesis_promotion_certificate`
- `paper_settlement`

Jangar emits a paper gate witness.

```text
torghut_capital_witness_quorum
  quorum_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  route_state                 # live_stable, escrow_repair_only, unstable
  observe_decision            # allow, hold
  repair_decision             # allow, repair_only, hold
  paper_decision              # allow, hold, block
  live_micro_decision         # allow, hold, block
  live_scale_decision         # allow, hold, block
  blocking_reason_codes[]
  required_repairs[]
  evidence_refs[]
  rollback_target
```

Rules:

1. `observe_decision=allow` can rely on live status or fresh route-stable snapshot escrow.
2. `repair_decision=allow` can rely on snapshot escrow only when `max_notional=0`.
3. `paper_decision=allow` requires live route stability, current Torghut receipts, current paper submit enablement, and
   no stale required receipts.
4. `live_micro_decision=allow` requires clean paper settlement, live action allow, current live submit enablement, and
   no open capital repair lease.
5. `live_scale_decision=allow` additionally requires expected shortfall coverage, after-cost guardrails inside limits,
   and no unresolved paper or live micro contradictions.
6. Fresh empirical jobs can reduce repair priority, but cannot satisfy forecast, TCA, market context, or promotion
   certificates by themselves.
7. Any route timeout, data receipt timeout, missing receipt, or direct database access failure is recorded as evidence,
   not silently ignored.

## Implementation Scope

Engineer lane:

1. Add a reducer under `services/jangar/src/server/` such as `control-plane-torghut-capital-evidence.ts`.
2. Feed it from `control-plane-empirical-services.ts`, route-stability escrow, negative evidence, material action
   verdicts, and the Torghut receipt payloads added by the companion contract.
3. Add the witness quorum to `/api/agents/control-plane/status?namespace=agents`.
4. Update `control-plane-negative-evidence-router.ts` so paper and live decisions consume the witness quorum instead
   of raw Torghut fragments when available.
5. Add fixtures for: fresh empirical jobs with stale TCA, market-context timeout, forecast registry empty, snapshot
   escrow repair-only route, complete paper gate, and live blocked without paper settlement.

Deployer lane:

1. Validate using typed routes first: Jangar control-plane status, Torghut `/trading/status`, Torghut
   `/trading/health`, Jangar quant health, and Jangar market-context health.
2. Treat direct database and ClickHouse credentials as optional evidence, not a release prerequisite.
3. Do not enable paper or live submit until the witness quorum reports `paper_decision=allow` or stronger.
4. Keep rollback to observe and zero-notional repair if the witness disappears, expires, or downgrades.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/agents/designs/144-jangar-capital-evidence-return-lane-and-paper-gate-witness-quorum-2026-05-07.md`
- `bun run --filter jangar test -- control-plane-empirical-services control-plane-negative-evidence-router control-plane-material-action-verdict`
- `bun run --filter jangar test -- control-plane-status`

Runtime validation:

- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/health`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m'`
- `curl --max-time 8 http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health`

Acceptance:

- Jangar reports a capital witness quorum with fresh evidence refs.
- Paper remains held when TCA is stale, market context times out, forecast registry is empty, submit is disabled, or
  no hypothesis is promotion eligible.
- Zero-notional repair remains available when route-stable snapshot escrow is fresh.
- Live micro and live scale remain blocked until paper settlement is clean.

## Rollout

1. Ship the reducer in shadow mode, adding only status payload fields.
2. Compare witness decisions with current material action receipts for at least one market session.
3. Make material action receipts consume the witness when both old and new decisions agree.
4. Enable paper gate enforcement after a deployer verifies route stability, current receipts, and no unexpected
   downgrades.
5. Enable live micro only after paper settlement receipts are clean and the Torghut companion scheduler has settled all
   required repairs.

## Rollback

Rollback is a feature-flag revert, not a data mutation:

- Hide or ignore the witness quorum field.
- Fall back to the existing negative evidence router and material action receipt logic.
- Keep `paper_canary`, `live_micro_canary`, and `live_scale` held.
- Keep Torghut submit disabled and max notional at `0`.
- Preserve emitted witness payloads as audit evidence.

## Risks

- The new witness can become another stale projection if TTLs are not strict.
- Forecast registry repair may lag behind TCA and market-context repair, keeping paper held longer than operators
  expect.
- A future privileged verifier might see direct database state that disagrees with typed receipts. The typed receipt
  remains the capital authority until the disagreement is resolved and published.
- Reused branch history has several older merged PRs. This contract should ship as a small incremental docs PR to keep
  the review scope narrow.

## Handoff Contract

Engineer acceptance gates:

- A typed Jangar reducer emits `torghut_capital_witness_quorum`.
- Unit tests cover stale TCA, market-context timeout, forecast registry empty, snapshot repair-only, complete paper,
  and live blocked before paper settlement.
- Jangar status includes receipt refs and blocking reasons without requiring privileged database access.

Deployer acceptance gates:

- Jangar status, Torghut status, Torghut health, quant health, and market-context health are captured before paper or
  live widening.
- Paper remains disabled until the witness quorum allows paper and Torghut submit is explicitly enabled by GitOps.
- Live remains disabled until paper settlement is clean and Jangar live action receipts allow live micro.
