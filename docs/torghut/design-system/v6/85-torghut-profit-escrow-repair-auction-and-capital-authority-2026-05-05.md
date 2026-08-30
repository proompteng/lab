# 85. Torghut Profit Escrow, Repair Auction, and Capital Authority (2026-05-05)

Status: Approved for implementation (`plan`)

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

Torghut should consume Jangar action authority through a **Profit Escrow and Repair Auction**. Non-shadow broker capital
must remain in escrow when Jangar holds `external_capital`, when quant proof is missing, when signal continuity is
alerting, or when no hypothesis is promotion eligible. Shadow, observe, replay, and repair work should continue, but
repair capacity should be auctioned to the highest information-value proof gaps instead of the loudest route failure.

I am choosing this because the current live evidence is no longer a simple "live gate says allowed" contradiction. It
is more nuanced and more important: Torghut is serving, schema-current, and shadow-capable, but capital proof is missing
or stale. `/trading/status` already reports `live_submission_gate.allowed=false` with `capital_stage=shadow`; the next
profitability gain comes from deciding which missing proof to repair first, then allowing capital only when the repaired
proof improves expected post-cost value.

## Evidence Snapshot

### Cluster and Rollout Evidence

All cluster checks were read-only.

- `kubectl get pods -n torghut -o wide` showed Torghut, Torghut simulation, Postgres, ClickHouse, ClickHouse Keeper,
  websocket forwarders, options services, TA services, exporters, Symphony, and Alloy running.
- Current Knative-style Torghut pods `torghut-00216` and `torghut-sim-00296` were `2/2 Running` during the sample.
- Events showed recent startup and readiness probe failures during revision turnover, followed by `RevisionReady` for
  Torghut and Torghut simulation.
- Events showed `torghut-db-migrations`, `torghut-whitepaper-semantic-backfill`,
  `torghut-whitepapers-bootstrap`, and `torghut-empirical-jobs-backfill` completing during the sampled window.
- Events also showed ClickHouse pods matching multiple PodDisruptionBudgets, which is a rollout-safety ambiguity for
  the data plane.
- The runner service account could list pods, jobs, PVCs, and events, but could not exec into the database pod or list
  CNPG clusters.

Interpretation: the service is operable enough to keep producing evidence, but the data plane and rollout context are
not quiet enough to infer capital authority from route liveness.

### Source and Test Evidence

The relevant source split is already clear:

- `services/torghut/app/main.py` owns health, status, and trading API route assembly.
- `services/torghut/app/trading/submission_council.py` is the stronger proof-aware admission path.
- `services/torghut/app/trading/scheduler/pipeline.py` records signal continuity, quant evidence, market context,
  capital stage, and control-plane snapshots.
- `services/torghut/app/trading/scheduler/safety.py` and governance modules handle promotion and rollback policy.
- `services/torghut/tests/test_trading_api.py`, `services/torghut/tests/test_submission_council.py`, and
  `services/torghut/tests/test_trading_scheduler_safety.py` already provide natural homes for route parity,
  broker-admission, and safety regression tests.

The missing design is not another route field. Torghut needs a single capital authority object consumed by route status,
scheduler decisions, and broker warrant minting, plus a way to spend repair capacity where it has the highest expected
profit value.

### Database, Data, and Profit Evidence

Allowed application evidence:

- `/db-check` returned HTTP 200 with `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, and `schema_graph_lineage_ready=true`.
- `/db-check` still warned about historical migration parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/trading/status` reported build `v0.568.5-9-gd73020e67`, active revision `torghut-00216`,
  `live_submission_gate.allowed=false`, reason `simple_submit_disabled`, and `capital_stage=shadow`.
- The same response reported `promotion_eligible_total=0`, `dependency_quorum_decision=informational_only`,
  `empirical_jobs_ready=null`, and `dspy_live_ready=null`.
- Quant evidence reported `required=false`, `status=not_required`, and `reason=quant_health_not_configured`.
- Signal continuity reported `alert_active=true` with alert reason `cursor_tail_stable` during the evidence window and
  only `3` universe symbols from the Jangar cache.
- `last_decision_at` was `2026-05-04T17:25:57.901670Z`, roughly one day old at the sample time.
- `/healthz` returned OK, while `/trading/health` returned 503.

Interpretation: Torghut is in the correct broad capital posture, but it is not yet profitable by construction. The
architecture should now convert holds into prioritized repair and experiment slots.

## Problem

Torghut has three different work classes:

1. answer routes and keep operators informed;
2. repair stale or missing evidence;
3. risk non-shadow broker capital.

The current posture correctly holds non-shadow capital, but it does not yet make repair capacity economically rational.
If quant health is not configured, signals are stale, empirical jobs are degraded, and market context is mixed, every
gap can claim to be urgent. Treating them all equally wastes the next market session.

The profitability goal is to convert missing-proof time into ranked experiments with measurable expected value. A
capital hold should not be passive. It should create a repair auction: which proof gap, if closed, is most likely to
unlock positive post-cost expected value without increasing live risk?

## Options Considered

### Option A: Keep Capital Shadow and Let Operators Repair Manually

Leave the current shadow-only posture in place and let humans decide whether to fix quant health, empirical jobs,
signal continuity, market context, or Jangar dependency proof first.

Pros:

- no additional runtime complexity;
- safe for broker capital;
- works with existing status pages.

Cons:

- slow learning loop;
- no audit trail for repair priority;
- no measurable profitability hypothesis per repair;
- repairs can chase loud alerts instead of highest expected value.

Decision: reject. It is safe but not ambitious enough for profitability.

### Option B: Force Quant Evidence Required Everywhere

Make quant evidence mandatory for every account/window and block all non-shadow activity until the Jangar quant route is
configured and healthy.

Pros:

- directly addresses the current `quant_health_not_configured` evidence;
- simplifies the broker-capital gate;
- aligns with recent proof-runway designs.

Cons:

- does not rank empirical-job, signal-continuity, and market-context repair;
- can block useful shadow or replay work;
- treats all hypotheses and accounts as equally valuable;
- creates a single dependency that may fail closed without producing learning.

Decision: reject as the whole design. Quant proof is required for capital, but not every repair or shadow action should
wait for it.

### Option C: Profit Escrow and Repair Auction

Hold non-shadow capital in escrow, keep observe/shadow/replay running, and run bounded repair auctions that rank proof
gaps by expected information value and capital unlock probability.

Pros:

- keeps capital safe while preserving learning;
- turns missing proof into prioritized, measurable experiments;
- binds repair priority to post-cost expected value rather than route noise;
- gives Jangar `external_capital` a Torghut-side consumer contract.

Cons:

- needs new persistence and tests;
- requires conservative scoring so the auction cannot become a capital bypass;
- adds one more operational concept for deployers.

Decision: select Option C.

## Chosen Architecture

### ProfitEscrowState

Torghut should persist one state row per account/window/release digest:

```text
profit_escrow_state
  account
  window
  release_digest
  jangar_authority_epoch_id
  external_capital_decision       # allow, degrade, hold, block
  capital_stage                   # observe, shadow, paper, canary, scale
  escrow_reason_codes
  max_notional_allowed
  proof_cut_digest
  observed_at
  fresh_until
  rollback_switch
```

This state does not authorize orders by itself. Broker admission still requires an order warrant. The escrow state tells
routes, scheduler, and operators why capital is held or allowed.

### RepairAuctionRound

When capital is held, Torghut should create a bounded repair auction:

```text
repair_auction_round
  round_id
  account
  window
  release_digest
  capital_hold_digest
  candidate_repairs
  winning_repairs
  expected_information_value
  expected_capital_unlock_probability
  max_runtime_budget
  observed_at
  expires_at
```

Candidate repairs are not trades. They are proof-producing actions such as configuring Jangar quant health, refreshing
empirical jobs, replaying a hypothesis family, repairing signal continuity, or refreshing market context. A candidate
must define expected output, validation command, maximum runtime budget, and a stop condition.

### Profitability Hypotheses

The first auction should score at least these hypotheses:

- `QUANT-CONFIG-01`: configuring and validating Jangar quant health for the active paper account/window reduces false
  positive capital holds and is a prerequisite for any non-shadow capital.
- `SIGNAL-CONTINUITY-02`: repairing cursor-tail stability and no-signal windows increases actionable signal coverage
  without changing broker risk.
- `EMPIRICAL-JOBS-03`: refreshing empirical jobs for the highest-volume shadow hypotheses improves promotion
  eligibility and gives the capital auction fresh post-cost evidence.
- `MARKET-CONTEXT-04`: targeted market-context refresh for the active universe improves risk filtering only after
  signal continuity is no longer alerting.

The expected value model should be conservative:

```text
expected_information_value =
  capital_unlock_probability
  * expected_post_cost_edge_bps
  * data_confidence
  * hypothesis_capacity_score
  - repair_runtime_cost
```

Any missing input forces the score down; it never invents capital authority.

### Capital Authority Consumption

Torghut should consume Jangar `external_capital` authority as one required input to broker warrants. The local escrow
must also require:

- quant evidence configured and fresh for the same account/window;
- signal continuity not alerting for the hypothesis source;
- empirical jobs fresh enough for the hypothesis family;
- no active rollback requirement;
- promotion eligibility above zero for the account/window;
- route, scheduler, and broker-admission parity on the same proof digest.

If any input is missing, routes can serve and shadow work can continue, but non-shadow warrants are held.

## Implementation Scope

Engineer scope:

1. Add persistence for `profit_escrow_state` and `repair_auction_round`, or extend the existing hypothesis governance
   tables if that is cleaner.
2. Add a pure escrow evaluator that consumes Jangar action authority, quant evidence, signal continuity, empirical-job
   readiness, promotion eligibility, and rollback state.
3. Add a pure repair-auction scorer with deterministic sorting and explicit missing-input penalties.
4. Wire `/trading/status`, `/trading/health`, scheduler snapshots, and broker warrant minting to the same escrow
   digest in shadow mode first.
5. Add regression tests for the current May 5 evidence cut: service OK, trading health 503, capital shadow, quant not
   configured, signal alert active, promotion eligible zero, and external capital held.
6. Add route parity tests so status and broker admission cannot drift.

Deployer scope:

1. Keep non-shadow capital enforcement in shadow/hold until route parity is proven.
2. Run one repair auction in shadow and inspect the winning repairs.
3. Enable repair-auction scheduling only for bounded, proof-producing tasks.
4. Enable broker-enforced capital escrow after route, scheduler, and broker warrant paths share the same digest.
5. Widen capital only after at least one hypothesis has fresh replay proof, quant proof, no signal-continuity alert,
   and positive post-cost expected value.

## Validation Gates

Unit gates:

- current evidence evaluates to `external_capital=hold`;
- `quant_health_not_configured` prevents non-shadow broker warrants but does not block shadow replay;
- active signal-continuity alerts reduce repair-auction score for capital widening and increase score for signal repair;
- promotion eligibility zero prevents non-shadow capital even if `/healthz` is OK;
- missing Jangar action authority holds capital and records a distinct reason code.

Integration gates:

- `/trading/status`, `/trading/health`, scheduler snapshot, and broker-admission path expose the same escrow digest;
- a Jangar `external_capital=hold` decision blocks non-shadow warrants;
- a successful repair auction records candidates, winner, expected output, expiry, and stop condition;
- a stale auction round cannot authorize capital after `expires_at`;
- account/window mismatch between Jangar authority and local proof holds capital.

Profit gates:

- first enabled repair auction must state its expected information-value formula and inputs;
- capital widening requires measured post-cost expected value greater than zero after fees/slippage;
- promotion requires no active signal-continuity alert for the relevant source;
- rollback triggers if realized slippage, stale quant proof, or dependency quorum breaches the configured budget.

## Rollout

Rung 1: shadow escrow state. Persist decisions from current status inputs without changing broker behavior.

Rung 2: route parity. Make status, health, scheduler, and broker-warrant paths report the same escrow digest.

Rung 3: shadow repair auction. Rank proof gaps but require manual approval for repair execution.

Rung 4: bounded repair execution. Allow only proof-producing repairs with runtime budgets and stop conditions.

Rung 5: broker escrow enforcement. Require fresh Jangar `external_capital` and local escrow proof for non-shadow
warrants.

Rung 6: controlled widening. Allocate capital only to hypotheses with fresh proof, positive post-cost expected value,
and no active rollback.

## Rollback

Rollback switches:

- `TORGHUT_PROFIT_ESCROW_MODE=shadow` disables broker enforcement while keeping escrow writes.
- `TORGHUT_REPAIR_AUCTION_MODE=shadow` disables repair execution while keeping ranking output.
- `TORGHUT_JANGAR_CAPITAL_AUTHORITY_MODE=ignore` reverts to the previous local gate during incident response, but the
  route must show that Jangar authority is being ignored.
- `TORGHUT_CAPITAL_WARRANT_MODE=shadow` stops non-shadow warrant enforcement without deleting warrants or escrow rows.

Do not delete escrow or repair-auction records during rollback. Negative evidence and failed repairs are part of the
profitability learning loop.

## Risks and Tradeoffs

The biggest risk is mistaking repair score for trading edge. The repair auction ranks evidence work, not orders. Broker
capital still requires a warrant and a fresh Jangar authority decision.

The second risk is delaying capital reentry too much. I accept that because current evidence has quant proof missing,
signal continuity alerting, and promotion eligibility at zero. Capital reentry without proof is not profitability.

The third risk is route complexity. The mitigation is a shared digest: routes, scheduler, and broker warranting must
read the same escrow evaluation.

The fourth risk is stale proof accumulation. Every escrow and auction row needs expiry, and expired rows are holds.

## Handoff

Engineer acceptance gate: implement the escrow evaluator, repair-auction scorer, persistence, route parity, and
broker-admission tests so the current May 5 evidence deterministically holds non-shadow capital while preserving
observe, shadow, replay, and bounded repair.

Deployer acceptance gate: run shadow escrow and one shadow repair auction, confirm route/scheduler/broker digest
parity, then enable bounded repair execution before broker escrow enforcement.

Owner acceptance gate: Torghut cannot claim profitability progress from route liveness. It can claim progress when a
repair auction closes a proof gap, a hypothesis receives fresh post-cost evidence, and Jangar plus Torghut agree on
capital authority for the same account/window.
