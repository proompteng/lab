# 98. Torghut Repair Dividend Ledger and Capital Reentry Guard (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

Torghut should publish a **RepairDividendLedger** that ranks zero-notional repair work by expected profitability value
and the exact stale proof it will reduce. Jangar's rollout brake decides whether the cluster can afford a repair launch;
Torghut decides whether the repair is worth spending that scarce launch.

The current system is safe but under-earning. Capital is correctly held in shadow, but stale empirical jobs from
2026-03-21 and eight recent rejected decisions have not been turned into a ranked repair program. The next architecture
step is not to unlock capital faster. It is to make repair work measurable enough that capital reentry can be earned.

The tradeoff is that Torghut must quantify repair value before it gets more launch capacity. I accept that tradeoff
because profitability work without measured repair dividends becomes busywork, and busywork is dangerous in a trading
system.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster Evidence

- Torghut live revision `torghut-00224` and sim revision `torghut-sim-00305` were `2/2 Running`.
- Torghut events still showed readiness and liveness probe timeouts on the current live pod.
- ClickHouse pods repeatedly matched multiple PodDisruptionBudgets, and the `torghut-keeper` PDB had no matching pods.
- The only recent Torghut namespace job was `torghut-empirical-artifacts-retention`, completed 18 hours earlier. No fresh
  empirical repair job was active.
- Direct pod exec and CNPG cluster reads were forbidden to the runtime identity, so normal proof must be route-level and
  least-privilege.

### Data Evidence

- `/healthz` returned OK; `/readyz` returned degraded state with Postgres OK, ClickHouse OK, Alpaca live broker OK, DB
  schema current, empirical jobs degraded, live submission blocked, and quant evidence not configured.
- `/db-check` showed schema current at Alembic head `0029_whitepaper_embedding_dimension_4096`, one current head, no
  missing or unexpected heads, and lineage ready with known parent-fork warnings.
- `/trading/health` reported three hypotheses, zero promotion eligible, three rollback required, dependency quorum
  blocked by `empirical_jobs_degraded`, and live submission held in shadow by `simple_submit_disabled`.
- `/trading/empirical-jobs` reported four stale but truthful empirical jobs:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all linked to
  `intraday_tsmom_v1@prod`, dataset `torghut-full-day-20260318-884bec35`, and March 21 S3 artifacts.
- `/trading/profitability/runtime` reported a 72-hour window with eight decisions, zero executions, zero TCA samples,
  and AAPL, AMD, INTC, and NVDA rejected by `microbar-volume-continuation-long-top2-v11`.
- ClickHouse guardrail metrics showed two reachable replicas, no read-only replicated tables, free disk ratios above
  0.96, fresh TA timestamps, and a successful scrape.
- Options catalog `/healthz` returned `ready=true` with `last_success_ts=null` and a timeout detail. That is a data proof
  gap, not a capital signal.

### Source Evidence

- `services/torghut/app/main.py` remains a large mixed route module at 3,981 lines. It should not be the only authority
  surface for repair economics.
- `app/trading/empirical_jobs.py` already knows stale, truthful, persisted, promotion-authority-eligible empirical job
  state.
- `app/trading/submission_council.py` already knows how to hold capital when empirical jobs, dependency quorum, or quant
  health are missing.
- `app/trading/hypotheses.py` and runtime profitability routes already expose hypothesis state, rejection counts, and
  dependency quorum. The missing piece is a compact repair-dividend compiler that ranks the work.
- Existing tests cover empirical job freshness, schema checks, trading health, runtime profitability, hypothesis quorum,
  promotion prerequisites, and submission council gates. Missing tests are repair dividend scoring, stale-proof repair
  ranking, options data proof gaps, and capital reentry refusal when dividend evidence is incomplete.

## Problem

Torghut currently knows why capital is blocked, but it does not price the repairs.

That matters because the correct next action is not "turn trading back on." The correct next action is to spend
zero-notional capacity on the repair with the highest expected value:

- empirical proof is old but truthful;
- runtime decisions exist but do not execute;
- options catalog readiness is not backed by a success timestamp;
- quant health is not configured;
- ClickHouse is healthy enough to support proof reads, but rollout events still show data-plane disruption risk.

Without a repair dividend, Jangar sees only degraded empirical jobs and blocked capital. It cannot decide whether the
next scarce launch should refresh empirical artifacts, analyze rejection reasons, repair options data proof, or wait for
rollout debt to clear.

## Alternatives Considered

### Option A: Re-run Empirical Promotion Jobs On A Fixed Schedule

Refresh the four stale jobs periodically and let existing promotion gates consume the result.

Pros:

- Directly fixes the oldest proof.
- Uses existing empirical job machinery.
- Easy to validate.

Cons:

- Ignores recent rejected decisions and options data gaps.
- Can waste cluster capacity during rollout debt.
- Does not tell Jangar why this repair outranks another repair.

Decision: keep as one repair type, not the architecture.

### Option B: Add A Capital Reentry Checklist

Document the manual checklist for fresh empirical jobs, quant health, options readiness, dependency quorum, and shadow
paper performance.

Pros:

- Clear for operators.
- Low implementation cost.
- Useful for rollback reviews.

Cons:

- Not machine-ranked.
- Does not provide a receipt Jangar can consume.
- Easy to bypass under schedule pressure.

Decision: useful as a runbook, insufficient as a control-plane contract.

### Option C: Repair Dividend Ledger

Publish a route-level ledger of zero-notional repairs with expected debt reduction, measured value, and capital reentry
eligibility impact.

Pros:

- Turns stale proof into ranked repair work.
- Lets Jangar apply rollout brakes without guessing trading value.
- Preserves capital fail-closed behavior.
- Produces measurable hypotheses instead of generic "improve profitability" work.

Cons:

- Requires a scoring model and tests.
- Needs conservative defaults while evidence is incomplete.
- Adds another route and schema to maintain.

Decision: select Option C.

## Chosen Architecture

### Route

Add a compact route:

```text
GET /trading/control-plane/repair-dividends
```

The route returns:

```text
repair_dividend_ledger
  schema_version
  generated_at
  fresh_until
  producer_commit
  active_revision
  data_schema
  capital_posture
  repair_candidates
  capital_reentry_guard
  source_refs
```

The route does not submit orders, launch jobs, or mutate records. It is proof for Jangar and operators.

### Repair Candidate

Each candidate carries:

```text
repair_candidate
  candidate_id
  repair_class
  target_debt
  expected_profit_value
  expected_risk_reduction
  expected_cost
  max_runtime
  max_parallelism
  success_gate
  rollback_gate
  evidence_refs
```

`expected_profit_value` is not a profit promise. It is a ranking signal that estimates the value of making the next
capital gate decidable.

### Required Current Candidates

1. `empirical_jobs_refresh_v1`
   - Target debt: stale empirical jobs.
   - Success gate: all four required jobs fresh, truthful, persisted, promotion-authority eligible, and linked to a
     current dataset snapshot.
   - Capital impact: can unlock paper-capital consideration only after Jangar dependency quorum is not blocked.

2. `runtime_rejection_attribution_v1`
   - Target debt: eight rejected decisions and zero executions in the 72-hour runtime window.
   - Success gate: every rejected AAPL, AMD, INTC, and NVDA decision gets a typed blocker reason and a repair path.
   - Capital impact: no capital unlock by itself; it decides whether the strategy needs data repair, policy repair, or
     retirement.

3. `options_catalog_proof_repair_v1`
   - Target debt: options catalog ready state without a success timestamp.
   - Success gate: `ready=true`, non-null `last_success_ts`, no current timeout detail, and source refs in the proof
     sample.
   - Capital impact: allows options data to participate in hypothesis evidence; cannot unlock live capital alone.

4. `quant_health_wiring_v1`
   - Target debt: quant health not configured.
   - Success gate: typed Jangar quant health URL configured, route reachable, freshness window satisfied, and Torghut
     submission council consuming it.
   - Capital impact: prerequisite for paper and live reentry.

### Capital Reentry Guard

Capital remains fail-closed. The ledger may rank repair work, but it cannot allow capital unless all of these are true:

- empirical jobs fresh and truthful;
- Jangar dependency quorum decision is `allow`;
- quant health is configured and fresh;
- options data proof is either healthy or explicitly out of scope for the hypothesis;
- rollout debt is below the Jangar action-class threshold;
- paper-capital evidence has completed before live-capital evidence.

`live_capital` must never be a delayed state. It is `allow` or `block`.

## Measurable Hypotheses

- Refreshing empirical jobs will convert `empirical_jobs_degraded` to healthy within one repair window without allowing
  live capital.
- Typed rejection attribution will explain all eight recent rejected decisions and reduce unknown blocker count to zero.
- Options catalog proof repair will replace `last_success_ts=null` with a fresh timestamp or explicitly remove options
  evidence from the affected hypotheses.
- Quant health wiring will change Torghut health from `quant_health_not_configured` to a fresh typed dependency while
  preserving shadow capital until paper gates pass.

## Validation Gates

Required engineer gates:

- Unit tests for dividend scoring with stale empirical jobs, zero executions, options timeout proof, and missing quant
  health.
- API tests for `/trading/control-plane/repair-dividends` proving deterministic schema and no mutation.
- Submission council tests proving repair dividends cannot override capital blockers.
- Runtime profitability tests proving rejected decisions are counted and linked to candidate repairs.

Required deployer gates:

- Read the route after deployment and confirm the four current repair candidates are present.
- Confirm `/trading/health` still holds capital in shadow while empirical jobs are stale or quant health is missing.
- Confirm Jangar status cites a matching repair action class before any repair job is launched.
- Confirm rollback can disable repair-dividend consumption without changing trading state.

## Rollout Plan

1. Ship the route in shadow mode with no Jangar enforcement.
2. Compare dividend ranking with existing operator intuition for one full swarm cadence.
3. Let Jangar consume the ledger only for `zero_notional_repair`.
4. After empirical and quant-health repairs are fresh, permit `paper_capital` review.
5. Keep `live_capital` blocked until paper evidence, dependency quorum, and rollout debt are all clean.

## Rollback Plan

Disable Jangar consumption of repair dividends and leave Torghut's existing submission council gates in place. Because
the route is read-only and zero-notional, rollback does not require database migration reversal or broker action. Any
repair jobs launched under the ledger must be allowed to finish or be stopped by their normal job TTL and rollback
policy.

## Risks

- Dividend scoring can overvalue easy repair work. Mitigation: separate expected value from capital unlock and require
  measured success gates.
- Stale evidence can make the same repair candidate appear forever. Mitigation: every candidate has `fresh_until` and a
  maximum retry debt budget.
- Options data may not be relevant to every hypothesis. Mitigation: require explicit in-scope/out-of-scope evidence per
  hypothesis.
- Jangar rollout debt may delay profitable repair. Mitigation: zero-notional repair has its own action class with lower
  threshold than implement and verify, but it still cannot ignore cluster instability.

## Handoff To Engineer And Deployer

Engineer acceptance gate: Torghut emits a deterministic, read-only repair dividend ledger that ranks the four current
repair candidates and proves none of them can unlock paper or live capital by themselves.

Deployer acceptance gate: after rollout, the ledger is readable, capital remains shadow, Jangar can cite the selected
repair candidate id, and disabling dividend consumption returns behavior to the previous fail-closed submission gates.
