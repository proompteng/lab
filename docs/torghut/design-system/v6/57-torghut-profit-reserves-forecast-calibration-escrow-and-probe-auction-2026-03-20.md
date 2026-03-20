# 57. Torghut Profit Reserves, Forecast Calibration Escrow, and Probe Auction (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/58-jangar-authority-journals-bounded-recovery-cells-and-replay-contract-2026-03-20.md`

Extends:

- `56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`
- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
- `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`

## Executive summary

The decision is to extend Torghut profit clocks into durable **Profit Reserves** with explicit **Forecast Calibration
Escrow** and a capped **Probe Auction**. The system should stop collapsing all mixed dependency states into a single
zero-capital answer and instead allocate only the capital class that the evidence can honestly support.

The reason is visible in the current live system on `2026-03-20`:

- `curl http://torghut.torghut.svc.cluster.local/trading/status`
  - returns `live_submission_gate.allowed = false`
  - returns `promotion_eligible_total = 0`
  - includes blocked reasons:
    - `alpha_readiness_not_promotion_eligible`
    - `empirical_jobs_not_ready`
    - `dependency_quorum_block`
    - `quant_health_fetch_failed`
    - `live_promotion_disabled`
  - still resolves quant evidence from
    `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?...`
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=15m`
  - returns HTTP `200`
  - returns `status="degraded"`
  - returns `latestMetricsCount = 0`
  - returns `runtimeEnabled = true`
- `curl http://torghut-forecast.torghut.svc.cluster.local:8089/readyz`
  - returns HTTP `503`
  - returns `reason = calibration_stale`
- `curl http://torghut-forecast-sim.torghut.svc.cluster.local:8089/readyz`
  - also returns HTTP `503`
  - also reports `calibration_stale`
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health`
  - returns `overallState="down"`
  - returns `bundleFreshnessSeconds = 347699`
  - returns `bundleQualityScore = 0.2075`
  - reports `clickhouse_query_failed`
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/summary?day=2026-03-20`
  - returns `generatedCount = 0`
  - returns `filledCount = 0`
  - returns `realizedPnl.value = 0`
  - still shows recent rolling rejection spikes on prior days

The tradeoff is more capital-state persistence and stricter reserve semantics. I am keeping that trade because the
current system is safe at blocking, but it is not good at preserving option value. It turns partial degradation into
complete inactivity even when some lanes still have enough evidence for bounded probe capital.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design documents that improve Jangar
  resilience and Torghut profitability

This artifact succeeds when:

1. Torghut settles one `profit_reserve_id` per lane and every capital-sensitive path can point to it;
2. forecast degradation becomes an explicit escrowed evidence component instead of a hidden whole-lane unknown;
3. healthy or partially healthy lanes can compete for strictly bounded probe capital without unlocking canary or live
   capital prematurely;
4. engineer and deployer stages have measurable profitability hypotheses and concrete rollback rules.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current runtime evidence says Torghut can still run, but it does not distinguish between "no live promotion" and "no
capital class at all".

- the main `torghut-00156` revision is serving;
- forecast and forecast-sim are both degraded on `calibration_stale`;
- the market-context plane is down from the perspective of Jangar consumers;
- ClickHouse freshness guardrails are degraded:
  - one replica reports `up = 0`
  - `torghut_clickhouse_guardrails_last_scrape_success = 0`
  - fallback counters continue increasing;
- the day-of trading summary is flat at zero while the recent rolling history still shows meaningful rejection
  structure.

Interpretation:

- Torghut does have mixed evidence, not absent evidence;
- it needs a finer capital state than today's global shadow-or-block answer.

### Source architecture and high-risk modules

The source tree shows exactly where the capital truth is still too coarse.

- `services/torghut/app/trading/submission_council.py`
  - still allows quant-health authority to fall back to generic control-plane status;
  - returns one live-submission gate payload rather than a durable reserve record;
  - still chooses one highest-capital valid candidate, so live capital remains effectively portfolio-global.
- `services/torghut/app/trading/hypotheses.py`
  - computes lane-level readiness and capital stage;
  - still reduces upstream capability truth to coarse reason lists and stage counts;
  - still shares major profitability inputs such as TCA summary and market-context freshness across hypotheses.
- `services/torghut/app/trading/portfolio.py`
  - already has deterministic sizing and fragility hooks;
  - does not yet allocate different capital classes based on escrowed evidence quality.
- `services/torghut/app/main.py`
  - `/readyz` and `/trading/status` reconstruct gate truth independently from scheduler execution.

Existing coverage is valuable but still incomplete:

- `services/torghut/tests/test_submission_council.py`
  - covers URL resolution and gate outcomes;
  - does not enforce typed rejection of generic control-plane status for quant authority.
- `services/torghut/tests/test_trading_pipeline.py`
  - covers capital-stage and gate behavior in many branches;
  - does not prove scheduler, `/readyz`, and `/trading/status` share one reserve identifier or that only the aligned
    hypothesis can receive non-shadow capital.
- `services/torghut/tests/test_hypotheses.py`
  - covers summary reduction and capital-stage totals;
  - does not model forecast escrow, bounded probe allocation, or hypothesis-local degradation.

### Database, schema, freshness, and consistency evidence

Torghut persistence is ready for additive reserve state.

- `curl http://torghut.torghut.svc.cluster.local/db-check`
  - returns `schema_current = true`
  - current head `0025_widen_lean_shadow_parity_status`
  - reports forked-parent lineage warnings but no head mismatch
- the source schema already includes:
  - `strategy_hypotheses`
  - `strategy_hypothesis_metric_windows`
  - `strategy_capital_allocations`
  - `strategy_promotion_decisions`
- direct CNPG SQL remains RBAC-forbidden for this worker:
  - `kubectl cnpg psql -n torghut torghut-db -- ...`
  - fails with `pods/exec is forbidden`

Interpretation:

- the database is not the blocker;
- the missing primitive is reserve-state settlement and capital-class allocation, not another broad gate bit.

## Problem statement

Torghut still has five profitability-critical gaps:

1. it settles only one coarse live-submission answer instead of one reserve state per lane;
2. forecast degradation currently destroys too much option value because it is not modeled as an escrowed evidence
   component with capital consequences;
3. wrong-endpoint upstream truth can still masquerade as valid quant authority;
4. scheduler, `/readyz`, and `/trading/status` can still drift because they do not share a single reserve record id;
5. partially healthy lanes cannot compete for bounded probe capital, so the system over-blocks when the evidence is
   mixed rather than catastrophically absent.

That is safe in the narrow sense, but it is not a profitable six-month architecture.

## Alternatives considered

### Option A: keep the current global gate and only fix the fallback URL

Summary:

- require the typed Jangar quant-health route;
- preserve one live-submission gate and today's capital stages.

Pros:

- smallest implementation delta;
- removes one obvious correctness bug.

Cons:

- still turns mixed dependency states into whole-system inactivity;
- does not encode forecast degradation as a capital-class decision;
- preserves drift between status surfaces and scheduler state.

Decision: rejected.

### Option B: move final capital decisions into Jangar

Summary:

- Jangar would issue lane capital answers directly;
- Torghut would only execute or refuse them.

Pros:

- one top-level authority owner;
- simple operator story on paper.

Cons:

- couples infrastructure authority to trading-local economics;
- enlarges Jangar's blast radius;
- slows future iteration on lane economics and calibration logic.

Decision: rejected.

### Option C: profit reserves plus forecast-calibration escrow and probe auction

Summary:

- Jangar provides typed upstream authority journals;
- Torghut settles those plus local evidence into reserve records;
- the portfolio allocator runs a strictly bounded probe auction over those reserves.

Pros:

- preserves ownership boundaries;
- converts partial degradation into explicit capital-class constraints instead of full inactivity;
- gives one durable id to scheduler, readiness, and status;
- increases future option value because reserve inputs can evolve without changing the whole gate model.

Cons:

- adds persistence and reserve-state math;
- requires new rollout and rollback discipline;
- makes capital semantics more explicit and therefore less forgiving.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will settle durable profit reserves per lane, escrow forecast-calibration debt explicitly, and use a capped
probe auction to allocate only the capital class the evidence can support.

## Architecture

### 1. Profit-reserve ledger

Add additive Torghut persistence:

- `profit_reserve_snapshots`
  - `profit_reserve_id`
  - `hypothesis_id`
  - `lane_id`
  - `strategy_id`
  - `capital_class` (`blocked`, `shadow`, `probe`, `canary`, `live`)
  - `journal_binding_digest`
  - `forecast_escrow_state`
  - `reserve_score`
  - `max_notional`
  - `reason_codes`
  - `fresh_until`
  - `produced_at`
- `profit_reserve_inputs`
  - normalized evidence subjects and scores used to derive the reserve;
- `probe_auction_allocations`
  - winning probe allocations by lane, account, and trading session.

### 2. Forecast calibration escrow

Forecast readiness becomes a first-class capital input.

States:

- `current`
  - forecast calibration fresh enough for normal scoring;
- `escrowed`
  - forecast stale or degraded; forecast-derived edge is removed from the reserve score, but other evidence may still
    support probe capital;
- `revoked`
  - forecast evidence too old or contradictory for even probe capital.

Rules:

- escrow can never unlock canary or live capital by itself;
- escrow may still allow `probe` if:
  - Jangar journal binding is fresh,
  - quant evidence is typed and fresh enough,
  - market-context risk does not exceed its lane budget,
  - empirical jobs or recent historical evidence still meet the lane's probe contract.

### 3. Probe auction

The portfolio allocator remains deterministic, but now prices reserve classes.

Per lane:

- compute a `reserve_score` from:
  - Jangar authority-journal freshness,
  - quant-health freshness,
  - forecast escrow state,
  - market-context quality,
  - empirical evidence freshness,
  - execution-quality and rejection history;
- derive a capped `probe_budget` from that score and lane fragility;
- allocate probe capital only among lanes with non-blocked reserve states.

Hard guardrails:

- no `canary` or `live` capital when:
  - forecast escrow is not `current`,
  - journal binding is stale,
  - empirical jobs are stale,
  - quant authority is sourced from a generic endpoint,
  - market-context quality is below the lane floor.

### 4. Unified serving contract

`/readyz`, `/trading/status`, scheduler decisions, and execution audit must all publish:

- `profit_reserve_id`
- `capital_class`
- `forecast_escrow_state`
- `journal_binding_digest`
- `auction_round_id`

That removes drift between status pages and actual trading decisions.

### 5. Measurable hypotheses

H1: bounded probe capital reduces zero-activity sessions.

- Target:
  - reduce sessions with `generatedCount = 0` by at least 50% over a 20-trading-day window,
  - while keeping maximum daily drawdown delta under `25` bps versus the current baseline.

H2: reserve-aware allocation reduces blocked-capital minutes.

- Target:
  - reduce blocked-capital minutes caused by a single degraded dependency by at least 60%,
  - without increasing policy veto or fallback ratio beyond the current alert thresholds.

H3: probe-class activity improves capital efficiency.

- Target:
  - improve realized PnL per active-capital hour by at least 15% over the shadow-only baseline,
  - while keeping average absolute slippage within the current lane promotion contracts.

## Validation gates

Engineer gate:

- typed quant authority is mandatory; generic control-plane fallback is rejected;
- reserve settlement emits one `profit_reserve_id` shared by scheduler and status routes;
- forecast escrow transitions are covered by tests;
- probe auction caps and lane deallocation rules are unit-tested.

Deployer gate:

- no rollout beyond shadow until reserve-state parity is visible in `/readyz` and `/trading/status`;
- probe auction is enabled only after a dry-run week with audit-only allocations;
- canary or live capital remains disabled until forecast escrow is `current` and empirical jobs are fresh.

Operational gate:

- alerts on:
  - stale forecast escrow duration,
  - reserve-id drift between scheduler and status,
  - probe-capital over-allocation,
  - wrong-endpoint quant authority attempts.

## Rollout

1. Introduce reserve settlement in audit-only mode while preserving current gate behavior.
2. Record `profit_reserve_id` in scheduler and status without using it for allocation yet.
3. Enforce typed quant-health binding and remove generic control-plane fallback.
4. Enable forecast escrow semantics with `probe` still disabled.
5. Run probe auction in dry-run mode and compare results against the shadow-only baseline.
6. Enable capped probe capital for one lane at a time, then expand only after hypothesis validation.

## Rollback

Rollback keeps persistence and turns off enforcement.

- preserve reserve and auction history for audit;
- disable probe auction and revert to current shadow-only gate evaluation;
- disable forecast-escrow enforcement only if it is the source of the fault;
- never re-enable generic quant-health fallback during rollback.

## Risks

- reserve scoring may overfit if probe budgets are not capped tightly enough;
- forecast escrow could be misused as a loophole if live-capital guardrails are not absolute;
- status/scheduler parity work may surface more latent drift before it simplifies operations.

Mitigations:

- strict probe ceilings and lane-by-lane rollout;
- hard bans on canary/live capital under escrow or stale journal bindings;
- parity tests before deployer enforcement.

## Handoff contract for engineer and deployer

Engineer stage:

1. Implement additive reserve, escrow, and probe-allocation tables.
2. Remove generic control-plane fallback from quant authority resolution.
3. Update scheduler, `/readyz`, and `/trading/status` to emit the same `profit_reserve_id`.
4. Add regressions for:
   - wrong-endpoint rejection,
   - forecast stale -> `probe` at most,
   - reserve-id parity,
   - probe deallocation on evidence decay,
   - multi-hypothesis submission where only the certificate-aligned lane can leave shadow,
   - preservation of concrete blocked reasons instead of flattening them to `capital_stage_shadow`.

Deployer stage:

1. Validate reserve parity in audit-only mode before allocation changes.
2. Require a visible `profit_reserve_id` and `journal_binding_digest` in rollout evidence.
3. Enable probe auction only for capped notional and one lane at a time.
4. Roll back to shadow-only allocation immediately if reserve parity drifts or probe guardrails are violated.
