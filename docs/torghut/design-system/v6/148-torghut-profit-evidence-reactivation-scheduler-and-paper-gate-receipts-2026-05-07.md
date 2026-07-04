# 148. Torghut Profit Evidence Reactivation Scheduler And Paper Gate Receipts (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut profitability, active proof repair scheduling, paper gate receipts, Jangar capital witness handoff,
validation, rollout, rollback, and implementation scope.

Companion Jangar contract:

- `docs/agents/designs/144-jangar-capital-evidence-return-lane-and-paper-gate-witness-quorum-2026-05-07.md`

Extends:

- `147-torghut-stale-proof-repair-exchange-and-route-stable-capital-quorum-2026-05-07.md`
- `146-torghut-submission-quorum-handoff-and-profit-repair-gates-2026-05-07.md`
- `144-torghut-state-coherent-profit-auction-and-tca-renewal-governor-2026-05-07.md`
- `143-torghut-empirical-relay-receipts-and-paper-gate-settlement-2026-05-07.md`

## Decision

I am selecting **a profit evidence reactivation scheduler with paper gate receipts** as the next Torghut architecture
step.

The system is not blocked because Torghut is dead. It is blocked because the live proof chain is stale in the exact
places that matter for capital. At `2026-05-07T11:27Z`, Torghut `/healthz` returned `ok`; live, sim, database,
ClickHouse, TA, options, and websocket pods were running; Alpaca account `PA3SX7FYNUTF` was `ACTIVE`; empirical jobs
were fresh and truthful; and Jangar quant latest metrics were populated. But `/db-check` timed out, `/trading/health`
was degraded, market-context health timed out through Jangar, TCA was more than 34 days old, forecast registry was
empty, no hypothesis was promotion eligible, simple submit was disabled, and the proof floor correctly held capital at
zero notional.

The selected design changes Torghut from a static repair list into an active reactivation scheduler. Every stale proof
dimension becomes a scheduled, expiring, zero-notional repair bid with a measurable after-cost capital unlock target.
When a repair settles, Torghut emits a paper gate receipt for Jangar. Paper opens only when all required receipts are
current: TCA, market context, forecast authority or explicit waiver, quant ingestion, hypothesis promotion
certificate, proof floor, stale-proof exchange, and submit enablement.

The tradeoff is that the first paper order is delayed until the proof surfaces converge. I accept that. The current
average absolute slippage is about `568.61` bps against an `8` bps guardrail. No serious quant system should paper
trade on that evidence just because the broker and database are reachable.

## Runtime Objective And Success Metrics

Success means:

- Torghut continues observe and zero-notional repair while `capital_state=zero_notional`.
- Stale TCA, stale market context, empty forecast registry, quant stage gaps, missing promotion certificates, and
  disabled submit each become explicit reactivation bids.
- Repair bids include expected after-cost dividend, expected capital unlock, route, validation command, TTL, maximum
  runtime budget, and required Jangar route state.
- Settled repairs emit typed paper gate receipts.
- Paper remains held until all paper gate receipts are current and Jangar's capital witness quorum allows paper.
- Live remains held until paper settlement is clean, expected shortfall coverage is present, and Jangar allows live
  micro.
- Rollback returns to observe, `simple_submit_disabled`, and `max_notional=0`.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- `kubectl get deploy -n torghut` showed `torghut-00254-deployment` and `torghut-sim-00354-deployment` available
  `1/1`.
- Torghut Postgres pod `torghut-db-1`, ClickHouse pods, Keeper, TA, sim TA, options TA, options catalog, options
  enricher, websocket services, guardrail exporters, Alloy, and Symphony pods were running.
- Events showed successful creation and completion of `torghut-db-migrations`, `torghut-empirical-jobs-backfill`,
  `torghut-whitepapers-bootstrap`, and `torghut-whitepaper-semantic-backfill` jobs during the current rollout window.
- Events also showed transient readiness/startup probe failures on live, sim, options, and websocket pods before
  recovery.
- ClickHouse continues to emit `MultiplePodDisruptionBudgets` warnings, and `torghut-keeper` continues to report
  `NoPods` for its PDB selector. That is cluster hygiene debt and should not be confused with capital readiness.
- The Knative service API was not listable from this runner, so deployer validation must use allowed deployment, pod,
  event, route, and typed status surfaces unless RBAC is widened.

### Trading And Capital Evidence

- `GET http://torghut.torghut.svc.cluster.local/healthz` returned HTTP 200 with `status=ok`.
- `GET http://torghut.torghut.svc.cluster.local/db-check` timed out after 8 seconds.
- `GET http://torghut.torghut.svc.cluster.local/trading/health` returned `status=degraded`.
- Scheduler, Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, empirical jobs, and quant evidence were
  individually reachable or informational.
- Alpaca account label `PA3SX7FYNUTF` was active.
- Live submission was `allowed=false`, reason `simple_submit_disabled`, and `capital_stage=shadow`.
- Profitability proof floor was `floor_state=repair_only`, `route_state=repair_only`,
  `capital_state=zero_notional`, and `max_notional=0`.
- Blocking reasons were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`, and
  `simple_submit_disabled`.
- TCA had `13,775` orders, last computed `2026-04-02T20:59:45.136640Z`, average absolute slippage about `568.61` bps,
  and slippage guardrail `8` bps.
- Market context was stale in Torghut status, and Jangar market-context health timed out after 8 seconds.
- Quant latest metrics were populated with `144` rows and `latestMetricsUpdatedAt=2026-05-07T11:25:11.400Z`, but the
  stage array was empty for the 15 minute account/window health check.
- Forecast service was `degraded`, `authority=blocked`, and `message=registry_empty`.
- LEAN authority remained disabled as a deterministic scaffold.
- Empirical jobs were fresh and promotion-authority eligible for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- The empirical candidate was `chip-paper-microbar-composite@execution-proof`, with dataset snapshot
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Alpha readiness had `3` hypotheses: `H-CONT-01` shadow, `H-MICRO-01` blocked, `H-REV-01` shadow,
  `0` promotion eligible, and `3` rollback required.

### Database And Data Evidence

- Direct Postgres inspection was blocked by RBAC: `kubectl cnpg psql -n torghut torghut-db -- -c select now();`
  failed because `pods/exec` is forbidden.
- Direct ClickHouse HTTP inspection was blocked by authentication: unauthenticated `SELECT now()` and `SHOW DATABASES`
  returned `REQUIRED_PASSWORD`.
- Runtime dependency checks still reported Postgres and ClickHouse `ok`, so the production verification contract must
  distinguish data-plane reachability from capital-grade data freshness.
- The key data-quality gap is not schema existence. It is proof freshness and consistency across TCA, market context,
  forecast registry, quant stages, and hypothesis promotion.

### Source Evidence

- `services/torghut/app/main.py` builds `/trading/health`, `/trading/status`, proof floor, live submission gate,
  quant evidence, forecast status, empirical jobs, and control-plane contract payloads. Its size is `4,124` lines, so
  new scheduling logic should not be embedded there.
- `services/torghut/app/trading/proof_floor.py` emits proof dimensions and a repair ladder, but the ladder is still a
  ranked receipt rather than an active scheduler.
- `services/torghut/app/trading/submission_council.py` evaluates promotion certificates, segment summaries, quant
  health, market context, and live submission blockers.
- `services/torghut/app/trading/empirical_jobs.py` signs empirical artifacts and verifies truthfulness, lineage,
  maturity, and promotion-authority eligibility.
- `services/torghut/app/trading/forecast_runtime.py` is the forecast authority boundary and currently reports
  `registry_empty` in runtime.
- `services/torghut/app/trading/hypotheses.py` owns hypothesis state and promotion reasons.
- `services/torghut/app/trading/tca.py` owns execution TCA evidence.
- The missing source boundary is a scheduler that consumes the proof floor and empirical evidence, schedules repair
  jobs, and emits paper gate receipts without widening capital.

## Problem

Torghut has a functioning runtime and fresh empirical artifacts, but the profit evidence required for paper and live
capital is stale or incomplete.

The failure modes are:

1. The proof floor lists repairs, but it does not schedule, expire, or settle repair bids.
2. Fresh empirical jobs do not automatically refresh TCA, market context, forecast authority, or hypothesis promotion.
3. `/db-check` timeout and typed dependency `ok` can coexist, so data reachability cannot be treated as data quality.
4. Forecast registry empty blocks forecast-backed promotion, but there is no paper gate receipt explaining whether a
   hypothesis has a forecast waiver.
5. Quant latest metrics are fresh while stage evidence is absent, so latest-store health and stage-carry health must
   remain separate.
6. Paper and live submit are disabled correctly, but the handoff to Jangar needs typed receipt refs rather than nested
   status fragments.

## Alternatives Considered

### Option A: Promote Paper From Fresh Empirical Jobs

Pros:

- Fastest route to new paper observations.
- Uses the strongest current positive evidence.
- Avoids new scheduler machinery.

Cons:

- Ignores TCA staleness and extreme slippage.
- Ignores stale market context and empty forecast registry.
- Produces paper evidence that cannot honestly support live capital.

Decision: reject.

### Option B: Keep The Current Static Proof-Floor Repair Ladder

Pros:

- Already implemented.
- Gives operators a readable repair order.
- Keeps capital safe.

Cons:

- Does not schedule repair work.
- Does not expire stale repair claims.
- Does not emit paper gate receipts for Jangar.
- Makes each stage manually rejoin Torghut, Jangar, and database evidence.

Decision: reject.

### Option C: Add A Profit Evidence Reactivation Scheduler

Pros:

- Converts stale proof into bounded zero-notional work.
- Keeps paper and live closed until receipts converge.
- Gives Jangar typed evidence return refs.
- Preserves the existing proof floor and submission council as enforcement inputs.
- Supports least-privilege verification through typed routes.

Cons:

- Adds a new scheduler and receipt schema.
- Requires calibration for expected after-cost dividend estimates.
- Can leave paper closed until multiple repair loops settle.

Decision: select Option C.

## Architecture

Torghut adds a reactivation scheduler keyed by account, revision, hypothesis, and market window.

```text
profit_evidence_reactivation_cycle
  cycle_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  proof_floor_ref
  stale_proof_exchange_ref
  repair_bids[]
  settled_receipts[]
  paper_gate_receipt
  live_gate_receipt
  rollback_target
```

Each repair bid is executable only at zero notional.

```text
profit_evidence_repair_bid
  bid_id
  proof_dimension
  blocker_code
  hypothesis_ids[]
  current_state
  target_state
  expected_after_cost_dividend_bps
  expected_capital_unlock
  max_runtime_seconds
  max_query_budget
  required_route_state
  validation_command
  expires_at
  decision
```

Settled receipts feed Jangar.

```text
paper_gate_receipt
  receipt_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  proof_floor_state
  tca_state
  market_context_state
  forecast_state
  quant_stage_state
  hypothesis_promotion_state
  submit_state
  decision
  blocking_reason_codes[]
  required_repairs[]
  evidence_refs[]
```

Rules:

1. `execution_tca_stale` schedules a TCA renewal bid before any paper gate can pass.
2. TCA renewal must prove current timestamp, sufficient sample count, average absolute slippage inside the hypothesis
   guardrail, and expected shortfall fields populated or explicitly waived.
3. `market_context_stale` schedules a market-context refresh bid for each affected hypothesis domain.
4. Market-context refresh must prove domain freshness, minimum quality, and no hard risk flags for the candidate.
5. `forecast_registry_empty` schedules a forecast registry repair or emits a hypothesis-scoped waiver.
6. Forecast waiver is allowed only when the hypothesis promotion contract marks forecast as non-required.
7. Quant latest-store health and quant stage health are separate receipts.
8. Fresh empirical jobs can satisfy empirical maturity, but they cannot satisfy promotion certificates until the
   submission council evaluates candidate tuples and lineage.
9. `simple_submit_disabled` is an absolute paper and live hold until GitOps explicitly enables paper submission.
10. Every receipt expires. Expired receipts return the paper gate to hold.

## Implementation Scope

Engineer lane:

1. Add `services/torghut/app/trading/reactivation_scheduler.py`.
2. Feed it from `proof_floor.py`, `submission_council.py`, `empirical_jobs.py`, `forecast_runtime.py`, `tca.py`,
   market-context status, quant evidence, and hypothesis runtime payloads.
3. Expose `profit_evidence_reactivation` and `paper_gate_receipt` on `/trading/status` and `/trading/health` in
   shadow mode.
4. Add receipt refs to the Jangar-facing control-plane contract payload.
5. Keep paper and live submit enforcement on the existing live submission gate until the scheduler has shadow parity.
6. Add tests for stale TCA, market-context timeout, forecast registry empty, quant latest fresh with missing stages,
   empirical jobs fresh but no promotion certificate, and complete paper gate.

Deployer lane:

1. Verify route payloads before any paper or live widening.
2. Treat direct database and ClickHouse reads as optional evidence because current RBAC and auth block them.
3. Keep submit disabled until Jangar's capital witness quorum and Torghut paper gate receipt both allow paper.
4. Roll back by disabling the reactivation scheduler field and leaving submit disabled.

## Validation Gates

Local validation:

- `uv sync --frozen --extra dev`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `uv run --frozen pytest tests/test_trading_api.py tests/test_profitability_proof_floor.py tests/test_submission_council.py`

Runtime validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/health`
- `curl --max-time 8 http://torghut.torghut.svc.cluster.local/db-check`
- `curl --max-time 8 http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m'`

Acceptance:

- Paper gate is `hold` while TCA is stale, market context is stale, forecast registry is empty, stage proof is absent,
  submit is disabled, or no hypothesis is promotion eligible.
- Reactivation bids are emitted for every blocker.
- Settled receipts include evidence refs and expiry.
- Jangar receives enough receipt refs to produce a capital witness quorum.
- Live remains blocked without clean paper settlement.

## Rollout

1. Ship the scheduler in shadow mode with no capital enforcement change.
2. Observe one full market session and compare scheduler bids to the existing proof-floor repair ladder.
3. Enable Jangar receipt ingestion after payload shape stabilizes.
4. Enable paper gate enforcement only after Jangar and Torghut decisions match for a full session.
5. Enable paper submit through GitOps only when paper gate receipt and Jangar witness quorum both allow paper.
6. Enable live micro only after paper settlement is clean and expected shortfall coverage is populated.

## Rollback

Rollback is conservative:

- Disable the reactivation scheduler payload field.
- Ignore emitted paper gate receipts in Jangar.
- Keep the existing proof floor and live submission gate as the enforcement path.
- Keep `simple_submit_disabled`.
- Keep all live notional at `0`.
- Preserve emitted receipts as audit evidence.

## Risks

- The scheduler can overfit repair priority to expected capital unlock if dividend estimates are not calibrated.
- Forecast registry repair may require model artifacts that are outside the current runtime image.
- Market-context health timeouts can keep paper held even when individual provider jobs are succeeding.
- The TCA gap is large enough that a single repair pass may produce an even stronger no-go result.
- ClickHouse PDB overlap is not a trading proof blocker, but it is still operational debt for deployer stages.

## Handoff Contract

Engineer acceptance gates:

- `profit_evidence_reactivation` and `paper_gate_receipt` are exposed in shadow mode.
- Tests prove fresh empirical jobs do not open paper when TCA, market context, forecast, stage proof, submit, or
  promotion certificates are missing.
- Paper gate receipts are hash-addressed, expiring, and consumable by Jangar.

Deployer acceptance gates:

- Capture Torghut status, Torghut health, Jangar control-plane status, Jangar quant health, and market-context health
  before paper or live widening.
- Do not use direct database or ClickHouse access as the only proof of readiness.
- Paper remains disabled until Torghut and Jangar both allow paper.
- Live remains disabled until paper settlement is clean and Jangar allows live micro.
