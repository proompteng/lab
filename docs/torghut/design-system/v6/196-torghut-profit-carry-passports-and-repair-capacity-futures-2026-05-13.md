# 196. Torghut Profit-Carry Passports And Repair Capacity Futures (2026-05-13)

Status: Accepted for Jangar engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut zero-notional profit repair, measurable hypothesis passports, repair capacity futures, Jangar rollout
proof integration, route custody, validation, rollout, rollback, and handoff.

Companion Jangar contract:

- `docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md`

Extends:

- `136-torghut-profit-proof-renewal-market-and-tca-settlement-2026-05-07.md`
- `195-torghut-stale-projection-foreclosure-and-route-custody-2026-05-13.md`
- `193-torghut-route-repair-yield-board-and-hypothesis-reentry-guardrails-2026-05-13.md`
- `192-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md`
- `188-torghut-profit-repair-clearance-packets-and-market-context-slos-2026-05-12.md`
- `docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md`

## Decision

I am selecting **profit-carry passports with repair capacity futures** as Torghut's companion architecture for the
Jangar rollout proof work.

Torghut should stay zero-notional. The current evidence is explicit: `/readyz` returns HTTP 503 with
`status=degraded`; live submission is blocked by `simple_submit_disabled`; active capital stage is `shadow`;
profitability proof floor is `repair_only`; capital state is `zero_notional`; promotion eligible hypotheses are `0`.
At the same time, this is not a dead system. Postgres, ClickHouse, Alpaca, database schema, universe, and empirical
jobs are healthy. The current capital replay board names repair candidates such as AAPL route rehab, NVDA proof refill,
and megacap breadth probes. It also states the right guardrail: `max_notional=0` for all selected replays.

The selected design makes each Torghut repair proposal carry a measurable profit passport before Jangar spends runner
capacity on it. The passport names the hypothesis, expected blocker delta, required receipts, route/TCA and
market-context guardrails, zero-notional capital effect, and the Jangar rollout proof passport it depends on. A repair
capacity future then decides whether the repair is worth launching in the current Jangar capacity window.

The tradeoff is that some plausible repairs will not run until they can state expected value and falsification rules.
That is the right tradeoff. Torghut's profitability problem is no longer "find more activity." It is "fund the
zero-notional repairs most likely to retire blockers that can later support paper evidence without violating guardrails."

This extends the 2026-05-07 profit-proof renewal market. That contract priced stale proof dimensions and kept paper
capital held until proof-floor settlement was current. This contract converts the current repair candidates into
per-hypothesis passports and capacity futures so Jangar can decide which zero-notional repairs deserve scarce runner
slots.

## Governing Runtime Requirements

This companion contract follows the active Jangar validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value gates for this contract:

- `routeable_candidate_count`
- `fill_tca_or_slippage_quality`
- `zero_notional_or_stale_evidence_rate`
- `post_cost_daily_net_pnl`
- `capital_gate_safety`

Jangar cross-plane value gates:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Current Evidence

Evidence was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database rows, broker state,
trading flags, GitOps resources, AgentRuns, or market data.

### Cluster And Runtime

- Argo CD reported `torghut` and `torghut-options` as `Synced/Healthy` at revision
  `704ef0aebc13722e541c006edddee4b4610c3424`.
- `torghut-00359-deployment=1/1` and `torghut-sim-00457-deployment=1/1` were ready on image digest
  `sha256:91963c9c35c26a1628107bf874876fc04c8b9dfa12cec8977ddd783f041dba4a`.
- Options catalog, options enricher, TA, TA sim, ClickHouse, Keeper, WebSocket services, guardrail exporters, and
  Torghut DB were running.
- Recent Torghut events showed normal rollout startup probe noise, completed DB migration and evidence backfill jobs,
  Knative revision readiness, and workflow failures in the whitepaper autoresearch profit target lane.

### Database And Data Quality

- `/db-check` returned `ok=true`, schema current at Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, one expected head, one current head, no missing heads, no
  unexpected heads, and lineage ready.
- The schema graph still reports known parent-fork warnings around historical migration branches. That is a lineage
  quality signal, not current schema drift.
- Direct CNPG resource inspection was not required for this pass; application-level read endpoints provided the
  production witness path available to normal workers.
- `/readyz` reported scheduler, Postgres, ClickHouse, Alpaca, database, universe, readiness cache, and empirical jobs
  OK.
- Live submission was blocked by `simple_submit_disabled`, with `capital_stage=shadow`, proof floor `repair_only`,
  and capital state `zero_notional`.
- Alpha readiness evaluated three hypotheses and kept all of them shadow-only. `H-CONT-01` and `H-REV-01` lacked
  strategy hypothesis lineage; `H-MICRO-01` had lineage but stale window evidence. `ta-core` was blocked by
  `signal_lag_exceeded`.

### Profit And Route Evidence

- The capital replay board selected three zero-notional repairs:
  - `H-AAPL-ROUTE-REHAB` with expected blocker delta `3`, but TCA slippage observed around `9.25` bps against an
    `8` bps guardrail.
  - `H-NVDA-SIM-PROOF-REFILL` with expected blocker delta `2`, but route universe/TCA evidence remained blocked and
    slippage observed around `13.48` bps against an `8` bps guardrail.
  - `H-MEGACAP-BREADTH-PROBE` for `AMZN`, `GOOGL`, and `ORCL`, with expected blocker delta `1` and missing route
    symbol evidence.
- The proof-floor blockers included `market_context_stale`, `market_context_state_unknown`,
  `quant_health_not_configured`, `hypothesis_not_promotion_eligible`, and `simple_submit_disabled`.
- The profit window contract had three windows: two `quarantined` and one `underfunded`. All windows were blocking.
- The route repair board summarized eight zero-notional route rows, with state counts `blocked=4`, `missing=3`, and
  `probing=1`. It named expected unblock value `14`, top repair symbols `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA`,
  and capital eligible symbol count `0`.
- Consumer evidence exposed a route warrant ref but also blockers such as `route_tca_missing`,
  `market_context_stale`, `max_notional_zero`, `profit_signal_quorum_observe_only`, and
  `routeability_acceptance_blocked`.

## Problem

Torghut has useful repair signals, but Jangar should not spend control-plane capacity on every repair signal. The
current repair surface has four gaps:

1. Repair candidates are measurable inside `/readyz`, but they are not yet a compact admission object for Jangar.
2. Expected profit impact is represented as blocker delta and repair value, but capacity cost is not settled before
   dispatch.
3. Guardrails are present, but the repair launch contract does not yet require a no-delta receipt when a repair fails
   to retire a blocker.
4. Route evidence can be useful for zero-notional repair while remaining unsafe for paper or live capital.

The profitability architecture must keep paper/live blocked while making zero-notional repair more selective and more
accountable. A run should launch because it can retire a named blocker inside a measured cost budget, not because a
large readiness payload contains a repair-looking field.

## Alternatives Considered

### Option A: Continue The Existing Repair Queue

This path lets market-context, route, empirical, and proof refill jobs continue using existing readiness blockers and
repair boards.

Advantages:

- No new payload.
- Keeps repair throughput high.
- Avoids coordination with Jangar rollout proof.

Disadvantages:

- Does not price runner capacity.
- Does not require a no-delta receipt for repeated repairs.
- Does not distinguish high-value AAPL/NVDA repairs from low-value breadth probes.
- Does not reduce failed AgentRuns when Jangar capacity is constrained.

Decision: reject as the primary architecture. Existing repair surfaces remain inputs, not admission.

### Option B: Freeze All Repair Until `/readyz` Is Healthy

This path blocks Torghut repair work until readiness is green.

Advantages:

- Simple and capital safe.
- Prevents repair churn during degraded windows.
- Avoids consuming Jangar runner capacity.

Disadvantages:

- Creates deadlock because repairs are how readiness improves.
- Wastes fresh empirical and route evidence.
- Delays learning on measurable zero-notional hypotheses.
- Increases manual intervention.

Decision: reject except as an incident fallback.

### Option C: Profit-Carry Passports And Repair Capacity Futures

The selected path emits a `profit_carry_passport` per repair hypothesis and a `repair_capacity_future` per proposed
launch window. Jangar may launch a Torghut repair only when the passport names its value, guardrails, receipts, and
zero-notional rollback target, and the capacity future says the work can run without stealing normal rollout capacity.

Advantages:

- Keeps capital safe while funding useful repairs.
- Turns repair work into measurable hypotheses.
- Connects Torghut work to Jangar runner capacity and rollout proof.
- Provides no-delta accounting for repairs that do not retire blockers.
- Lets Jangar reduce failed AgentRuns by refusing low-value repairs during constrained capacity windows.

Disadvantages:

- Adds a new payload and tests.
- Requires stable reason codes and receipt names.
- May hold repairs that operators would otherwise launch manually.

Decision: select Option C.

## Architecture

### Profit-Carry Passport

```text
profit_carry_passport
  schema_version = torghut.profit-carry-passport.v1
  passport_id
  generated_at
  fresh_until
  account
  window
  hypothesis_id
  candidate_id
  target_symbols[]
  repair_class
  expected_blocker_delta
  expected_profit_effect
  expected_cost_class
  max_runtime_seconds
  max_notional = 0
  required_receipts[]
  current_blockers[]
  guardrails[]
  falsification_rules[]
  jangar_rollout_proof_passport_ref
  jangar_runner_capacity_future_ref
  decision = repair_only | hold | block
  reason_codes[]
  rollback_target
```

Every passport must satisfy these rules:

- `max_notional` is always `0` until a separate future capital passport exists.
- `paper_canary`, `live_micro_canary`, and `live_scale` remain blocked by this contract.
- Expected blocker delta must be positive for a repair launch.
- The repair must name the receipt schema it is expected to produce.
- A repeated repair with no new receipt emits a no-delta receipt and loses priority.
- Guardrails are evaluated before launch and again after receipt settlement.

### Repair Capacity Future

```text
repair_capacity_future
  schema_version = torghut.repair-capacity-future.v1
  future_id
  generated_at
  fresh_until
  account
  window
  repair_class
  expected_runtime_seconds
  expected_cost_class
  expected_blocker_delta
  jangar_stage_launch_ticket_ref
  capacity_decision = available | constrained | unavailable
  reason_codes[]
```

The future is not a Kubernetes reservation. It is a cross-plane scheduling promise: Torghut says the repair is worth
the slot, and Jangar says a slot is likely to schedule and finish. If either side says constrained, only bounded repair
dispatch can run. If either side says unavailable, the repair stays held.

## Measurable Trading Hypotheses

### Hypothesis 1: AAPL Route Rehab

- Current evidence: AAPL route state is `probing`, current blocker
  `route_tca_passed_but_dependency_receipts_block_capital`, observed slippage around `9.25` bps, guardrail `8` bps.
- Passport decision: `hold` until the TCA receipt and market-context receipt are fresh; `repair_only` after receipts
  are named and no notional is requested.
- Expected blocker delta: `3`.
- Guardrails: no paper/live notional, slippage at or below `8` bps after repair, fresh market-context receipt, alpha
  readiness not worse than before.
- Falsification: if repaired AAPL still exceeds the `8` bps slippage guardrail or lacks a fresh market-context
  receipt, emit no-delta receipt and lower priority.

### Hypothesis 2: NVDA Simulation Proof Refill

- Current evidence: NVDA route state is `blocked`, current blocker
  `execution_tca_route_universe_exclusions_applied`, observed slippage around `13.48` bps, guardrail `8` bps.
- Passport decision: `hold` until route universe and TCA receipts are present; repair may run only as a bounded
  simulation proof refill.
- Expected blocker delta: `2`.
- Guardrails: no notional, no paper graduation from this repair alone, TCA slippage must improve before the repair can
  be considered successful, market-context remains fresh for the account/window.
- Falsification: no improvement in slippage or missing route universe receipt produces no-delta debt.

### Hypothesis 3: Megacap Breadth Probe

- Current evidence: AMZN, GOOGL, and ORCL route evidence is missing, with `execution_tca_symbol_missing`.
- Passport decision: `repair_only` only when Jangar has spare repair capacity; otherwise hold.
- Expected blocker delta: `1`.
- Guardrails: no notional, route coverage receipt required, no degradation to current AAPL/NVDA repair queues, market
  context freshness bound by the repair window.
- Falsification: if route coverage remains missing or costs exceed the budget, emit no-delta receipt and pause breadth
  probes until higher-value repairs settle.

### Hypothesis 4: H-MICRO-01 Window Evidence Refill

- Current evidence: `H-MICRO-01` has strategy lineage, but window evidence is stale and `ta-core` is blocked by
  `signal_lag_exceeded`.
- Passport decision: `repair_only` after capacity is available and required TA/evidence receipts are named.
- Expected blocker delta: `2`, because it can move the only lineage-ready hypothesis from underfunded to paper
  candidate if freshness and signal lag repair.
- Guardrails: max notional `0`, signal lag under the configured threshold, no paper graduation until profit-window and
  Jangar source-serving proof are current.
- Falsification: stale window evidence after repair or unchanged signal lag becomes no-delta debt.

## Implementation Milestones

### Milestone 1: Passport Reducer

Value gates: `routeable_candidate_count`, `handoff_evidence_quality`, `ready_status_truth`.

- Build a pure Torghut reducer that turns capital replay board, route repair board, proof floor, market context, and
  alpha readiness into `profit_carry_passport` objects.
- Expose the payload through `/trading/consumer-evidence` first.
- Tests must cover AAPL, NVDA, megacap breadth, and H-MICRO-01 cases.

### Milestone 2: No-Delta Receipts

Value gates: `zero_notional_or_stale_evidence_rate`, `manual_intervention_count`.

- Define `torghut.repair-no-delta-receipt.v1`.
- Emit no-delta receipts when a repair consumes a slot but does not retire its named blocker.
- Jangar terminal debt compaction should consume the receipt so repeated low-value repairs lose priority.

### Milestone 3: Repair Capacity Future Bridge

Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`.

- Bind each passport to a Jangar runner capacity future and stage launch ticket.
- Allow high-value repairs during constrained capacity only when they retire a blocker with expected delta at least `2`.
- Hold breadth probes when normal rollout or verify capacity is constrained.

### Milestone 4: Guardrail Settlement

Value gates: `fill_tca_or_slippage_quality`, `capital_gate_safety`.

- Re-check slippage, market-context freshness, alpha readiness, and signal lag after the repair receipt.
- Require every successful repair to update the passport with before/after evidence.
- Keep paper and live blocked until a later capital passport exists.

### Milestone 5: Deployer And Trader Cutover

Value gates: `post_cost_daily_net_pnl`, `handoff_evidence_quality`.

- Deployer checks that Torghut repair passports are present and zero-notional after rollout.
- Trader review checks blocker deltas and no-delta receipts before raising repair budget.
- Record before/after routeable candidate count, repair no-delta rate, and slippage guardrail pass rate.

## Validation Gates

Engineer stage is not complete until:

- Unit tests cover passport generation for the four named hypotheses.
- Unit tests cover no-delta receipt downgrade behavior.
- Unit tests prove max notional remains `0` for all repair passports.
- Regression tests prove paper/live action classes cannot be enabled by this contract.
- `bunx oxfmt --check` passes for touched Markdown and TypeScript/Python paths.
- Torghut targeted tests pass for every touched reducer if implementation changes source.

Verify stage is not complete until:

- Argo reports `torghut`, `torghut-options`, `jangar`, and `agents` synced and healthy, or exact non-healthy reasons
  are recorded.
- Torghut `/db-check` remains schema-current.
- Torghut `/readyz` may remain degraded only for capital/profit guards, not database or unknown projection authority.
- `/trading/consumer-evidence` includes profit-carry passports after implementation.
- Jangar stage launch ticket names the Torghut passport for any Torghut repair dispatch.
- No paper or live notional is enabled.

## Rollout Plan

1. Emit profit-carry passports in observe mode.
2. Add no-delta receipt generation without changing repair launch behavior.
3. Connect passports to Jangar runner capacity futures for repair prioritization.
4. Hold low-delta repairs during constrained capacity windows.
5. Use before/after receipts to graduate only repairs that actually retire blockers.

## Rollback Plan

Rollback is configuration-first:

- ignore profit-carry passports in Jangar repair admission;
- keep existing Torghut repair boards and proof floor as the status source;
- preserve emitted passports and no-delta receipts for audit;
- do not delete trading rows, receipts, or AgentRuns during rollback;
- keep max notional `0` and paper/live blocked.

If the passport route destabilizes Torghut readiness, roll back the Torghut deployment image and keep existing
consumer-evidence and proof-floor contracts.

## Risks And Mitigations

- Risk: the passport underfunds a repair that later proves valuable. Mitigation: keep observe-mode collection and allow
  manual trader review to raise priority with evidence.
- Risk: no-delta receipts punish useful exploratory repairs. Mitigation: no-delta only lowers repeated priority; it
  does not delete evidence or prevent new hypotheses with new receipts.
- Risk: capacity futures starve Torghut repairs during Jangar incidents. Mitigation: allow high-delta zero-notional
  repairs while normal rollout is held, but block low-delta breadth probes.
- Risk: slippage guardrails overfit one sample. Mitigation: require before/after receipt windows and market-context
  freshness, not one point estimate.
- Risk: operators confuse repair passports with capital permission. Mitigation: every passport carries
  `max_notional=0`, explicit paper/live block, and rollback target.

## Handoff To Engineer

Build the reducer and fixtures first. Do not change live submission, paper canary, or capital gates. The first PR
should expose passports through consumer evidence and prove max notional stays zero.

Acceptance gates:

- AAPL, NVDA, megacap breadth, and H-MICRO-01 produce deterministic passports;
- every passport has expected blocker delta, guardrails, required receipts, and falsification rules;
- no-delta receipts lower priority for repeated no-effect repairs;
- Jangar can reference a passport from a stage launch ticket;
- tests prove paper/live cannot be unlocked by this design.

## Handoff To Deployer

Deployer should treat profit-carry passports as repair prioritization evidence, not capital evidence. A rollout is
acceptable when Torghut service health is stable, database schema is current, passports are present or explicitly not
yet implemented, and every repair passport keeps max notional at `0`.

Rollout acceptance gates:

- Torghut and Jangar Argo apps are synced and healthy;
- Torghut `/db-check` is current;
- repair passports are emitted after implementation;
- Jangar runner capacity futures are referenced for launched repairs;
- paper/live remain blocked until a separate capital cutover design and implementation lands.
