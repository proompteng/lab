# 88. Torghut Session Proof Liquidity and Hypothesis Market Maker (2026-05-05)

Status: Approved for implementation (`discover`)

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

Torghut should add a **Session Proof Liquidity Ledger** and a **Hypothesis Market Maker** above repair alpha bids.
Repair bids choose the next repair. The missing layer is liquidity: during a market session, which proof is valuable
enough to buy with scarce runtime, stale evidence, and no current order samples?

I am choosing a proof-liquidity market because the refreshed 2026-05-05 evidence says Torghut should learn
aggressively but keep capital closed:

- live Torghut revision `torghut-00219` served `/healthz` with HTTP 200;
- live `/readyz` timed out from this runner after 15 seconds;
- live `/trading/health` returned `status=degraded` with Postgres, ClickHouse, Alpaca, and Jangar universe healthy,
  but `live_submission_gate.ok=false` and `reason=simple_submit_disabled`;
- `/db-check` reported `schema_current=true`, current and expected head `0029_whitepaper_embedding_dimension_4096`,
  `schema_graph_lineage_ready=true`, and account-scope checks bypassed only because multi-account trading is disabled;
- `/trading/status` reported `mode=live`, `execution_lane=simple`, `capital_stage=shadow`,
  `promotion_eligible_total=0`, and `rollback_required_total=3`;
- `/trading/empirical-jobs` still had stale but truthful promotion-authority jobs from
  `2026-03-21T09:03:22.150009Z` for `intraday_tsmom_v1@prod`;
- `/trading/profitability/runtime` had a 72-hour window with eight decisions, zero executions, and zero TCA samples;
- `/trading/tca` had 13,775 historical order samples, but `last_computed_at=2026-04-02T20:59:45.136640Z` and average
  absolute slippage around 568.6 bps;
- the options catalog pod was running, but `/readyz` returned `ready=false` with `last_success_ts=null`;
- Jangar quant-health timed out from this runner, direct SQL was blocked by `pods/exec` RBAC, and CNPG CR reads were
  forbidden.

The decision is to create a no-notional market for proof. Hypotheses bid for session proof liquidity. Torghut buys the
proof that can close the most capital-blocking uncertainty per unit of session time. Broker orders remain blocked until
fresh empirical proof, route proof, TCA proof, Jangar platform proof, and live-submission warrants all agree.

## Scope and Success Metrics

This contract covers the Torghut-side profitability architecture. It does not open paper or live submission.

Success means:

1. every blocked hypothesis has a proof-liquidity quote with evidence age, opportunity window, expected edge, and
   guardrail debt;
2. stale empirical proof, stale TCA, zero recent executions, options readiness gaps, quant-health timeouts, and Jangar
   action holds affect the quote as separate discounts;
3. the market maker can select zero-notional proof work for a market session without granting broker authority;
4. selected proof work produces either closure proof, lower-severity debt, or falsification;
5. status, health, scheduler snapshots, and Jangar projections expose the same proof-liquidity digest;
6. engineer and deployer stages can validate one narrow hypothesis lane without pretending the whole trading system is
   capital-ready.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Rollout Evidence

Torghut was serving but not cleanly trade-ready:

- `kubectl get pods -n torghut -o wide` showed live `torghut-00219`, sim `torghut-sim-00300`, Torghut Postgres,
  ClickHouse, Keeper, TA jobs, options services, websocket forwarders, Symphony, and exporters running.
- Recent Torghut events showed normal revision creation for `torghut-00219` and `torghut-sim-00300`, transient startup
  and readiness probe failures, and completed migration, empirical backfill, bootstrap, and semantic backfill jobs.
- Events also showed repeated ClickHouse `MultiplePodDisruptionBudgets`, `torghut-keeper` PDB `NoPods`, Flink
  checkpoint/fetch exceptions, and scheduling pressure for backfill pods.
- The active options catalog pod was ready at the Kubernetes level, but its service `/readyz` returned a payload with
  `ready=false` and no last successful cycle.

Interpretation: the cluster can run bounded proof work, but it should not infer capital readiness from pod readiness.

### Source and Test Evidence

The source has the right building blocks but the ownership is too concentrated:

- `services/torghut/app/main.py` is 3,981 lines and aggregates health, readiness, status, profitability, TCA, decisions,
  executions, LLM state, empirical jobs, market context, and Jangar dependency quorum.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4,280 lines and remains the highest-risk place for admission
  and promotion behavior.
- `services/torghut/app/trading/empirical_jobs.py` is 561 lines and already models stale/truthful empirical authority.
- `services/torghut/app/trading/discovery/promotion_contract.py` and
  `services/torghut/app/trading/evidence_contracts.py` are small enough to receive pure quote and digest builders.
- Tests already cover empirical jobs, autonomy gates, completion traces, submission council behavior, trading API
  surfaces, scheduler safety, runtime profitability, and quant readiness. The gap is a cross-route proof-liquidity
  invariant: selected proof work must be visible everywhere and must never authorize notional by itself.

Interpretation: implementation should start with pure builders and route parity tests, not scheduler rewrites.

### Database and Data Evidence

Direct database SQL was not available to this runner:

- `kubectl cnpg psql -n torghut torghut-db -- -c 'select now();'` failed because
  `system:serviceaccount:agents:agents-sa` cannot create `pods/exec` in namespace `torghut`;
- listing `clusters.postgresql.cnpg.io` in `torghut` and `jangar` was forbidden;
- `/db-check` still gave current schema, lineage, and account-scope evidence through the application route.

Application data evidence is mixed:

- schema and account-scope proof are current;
- empirical proof is truthful but stale by more than a month;
- runtime decisions exist, but there are no current executions or TCA samples in the 72-hour profitability window;
- historical TCA is old and too noisy to price fresh capital confidently;
- options catalog readiness has not produced a successful cycle timestamp.

Interpretation: the data layer is not missing. It is illiquid. The system has old proof, route proof, and rejection
proof, but too little fresh execution proof.

## Problem

Repair bids answer "what should we fix next?" They do not answer "what proof is worth buying during this session?"

Torghut currently has competing proof needs:

1. refresh stale empirical jobs for `intraday_tsmom_v1@prod`;
2. recover or configure Jangar quant-health;
3. replay eight rejected runtime decisions from the last 72 hours;
4. refresh TCA and expected shortfall evidence;
5. recover options catalog readiness;
6. repair signal continuity and market-context proof;
7. keep all three current hypotheses in shadow until proof is fresh.

Treating all of those as equal wastes market time. Treating liveness as proof risks bad capital. Torghut needs a
proof-liquidity layer that prices evidence, not optimism.

## Options Considered

### Option A: Global No-Trade Freeze Until Every Gate Is Green

Torghut would avoid all proof work until Jangar execution trust, empirical jobs, TCA, options readiness, quant-health,
and live readiness are green.

Pros:

- simplest safety model;
- no chance of a proof budget being mistaken for order authority;
- easy for deployers to enforce.

Cons:

- wastes the current rejected-decision and session context;
- delays falsification of weak hypotheses;
- makes stale proof older while waiting for unrelated platform repair;
- reduces future option value because we learn nothing during the hold.

Decision: reject as the primary architecture. It remains the emergency posture for broken route integrity.

### Option B: Reopen Paper Micro-Notional to Gather Fresh Samples

Torghut would turn paper submission back on at tiny size to collect current fills, TCA, and broker behavior.

Pros:

- directly produces execution samples;
- likely to expose broker and sizing bugs faster than replay;
- can shorten the path to a real profitability signal.

Cons:

- current empirical proof is stale;
- live readiness timed out, options catalog readiness is false, and Jangar quant-health timed out;
- zero recent executions means we cannot calibrate the current fill path;
- it treats paper order flow as diagnostic infrastructure instead of a capital decision.

Decision: reject for the current state. Paper reentry should be earned by proof liquidity closure.

### Option C: Session Proof Liquidity Ledger and Hypothesis Market Maker

Torghut prices proof demand from each hypothesis, scores proof supply from Jangar and local routes, and selects
zero-notional proof work for the current session.

Pros:

- keeps safety and learning aligned;
- makes opportunity cost explicit;
- lets one nearly-ready lane advance without pretending all lanes are ready;
- separates proof liquidity from capital liquidity;
- creates a measurable handoff for engineer and deployer stages.

Cons:

- adds a new digest and scoring surface;
- first scoring model will be ordinal and conservative;
- requires route parity to avoid inconsistent status and scheduler decisions.

Decision: select Option C.

## Chosen Architecture

### SessionProofLiquidityLedger

Torghut should materialize one ledger per account and market session:

```text
session_proof_liquidity_ledger
  ledger_id
  account
  session_window
  generated_at
  market_session_state
  jangar_evidence_liquidity_digest
  empirical_liquidity_state
  tca_liquidity_state
  options_liquidity_state
  runtime_decision_window
  open_profit_debt_count
  selected_quote_ids
  capital_authority_state       # shadow, paper_held, live_held, paper_allowed, live_allowed
  digest
```

The ledger is an evidence object. It is not an order object.

### HypothesisProofQuote

Every hypothesis gets a quote:

```text
hypothesis_proof_quote
  quote_id
  ledger_id
  hypothesis_id
  strategy_family
  current_state                # blocked, shadow, canary_paper, scaled_live
  expected_edge_bps_if_proven
  opportunity_window_minutes
  evidence_age_penalty
  stale_empirical_penalty
  stale_tca_penalty
  zero_execution_penalty
  route_health_penalty
  platform_hold_penalty
  downside_risk_score
  expected_information_value
  proof_liquidity_score
  selected_repair_classes
  max_notional                 # zero unless a separate warrant permits capital
  closure_condition
  falsification_condition
```

The first implementation should use ordinal scoring. The ranking must be explainable, not falsely precise.

### Initial Hypothesis Prices

The current evidence prices the lanes this way:

- `H-CONT-01` should bid first for empirical refresh, rejected-decision replay, and signal continuity because it has
  current rejected decisions in liquid chip names and two global blockers.
- `H-REV-01` should bid second for market-context and quant-health proof. Its edge depends on timely context, so stale
  route proof discounts it heavily.
- `H-MICRO-01` should bid third until feature and drift proof exist. Microstructure experiments should not receive
  canary budget while feature rows and drift evidence are missing.

### Measurable Trading Hypotheses

The proof-liquidity layer must make hypothesis tests concrete:

- `H-CONT-01`: over the next five regular sessions, replay rejected AAPL, AMD, INTC, and NVDA decisions against fresh
  bars and refreshed empirical jobs. Advance to paper only if post-cost expected edge is positive, empirical jobs are
  fresh inside 24 hours, TCA is recomputed inside seven days, and no Jangar external-capital hold remains open.
- `H-REV-01`: run event-reversion replay only when market-context freshness is inside 30 minutes for news and one day
  for fundamentals, with quality at or above 0.4. Falsify the session if the event window cannot be refreshed before
  half the opportunity window expires.
- `H-MICRO-01`: run feature and drift repair before any replay. Advance only if required feature coverage and drift
  proof are present for the strategy family, expected shortfall coverage is non-zero, and simulated adverse excursion
  does not exceed the hypothesis threshold.

### Guardrails

No selected quote can authorize notional unless all of these are true:

- live submission gate is no longer blocked by `simple_submit_disabled`;
- empirical jobs are fresh, truthful, and promotion-authority eligible for the candidate;
- TCA and expected shortfall evidence are current for the route;
- Jangar evidence liquidity has no open `external_capital` hold for the account and release digest;
- options catalog readiness is green when the hypothesis depends on options data;
- the selected quote has a matching order warrant and profit evidence lease.

## Implementation Scope

Engineer-stage implementation should land in bounded slices:

1. Add pure builders for `SessionProofLiquidityLedger`, `HypothesisProofQuote`, and digest computation.
2. Build quotes from existing status, empirical jobs, TCA, runtime profitability, market context, options readiness, and
   Jangar evidence-liquidity inputs.
3. Expose ledger digest, top quotes, selected repair classes, and max notional on `/trading/status`,
   `/trading/health`, scheduler snapshots, and runtime profitability.
4. Add fixtures for the May 5 state: stale empirical jobs, zero executions, old TCA, quant-health timeout,
   options catalog not ready, and Jangar execution-trust hold.
5. Add tests proving selected proof quotes default to `max_notional=0`.
6. Add broker-admission tests proving proof liquidity cannot open paper/live capital without a separate order warrant.
7. Add deploy validation that one narrow hypothesis can receive proof work while capital remains shadow.

## Validation Gates

Required local validation for implementation PRs:

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k "status or health or live_submission_gate"`
- `uv run --frozen pytest services/torghut/tests/test_empirical_jobs.py`
- `uv run --frozen pytest services/torghut/tests/test_profitability_evidence_v4.py`
- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- all three Torghut Pyright profiles when runtime code changes touch `services/torghut`

Required deployed validation:

- `/trading/status`, `/trading/health`, runtime profitability, and scheduler snapshots expose the same ledger digest;
- the May 5 state selects zero-notional proof work and keeps `capital_stage=shadow`;
- a stale empirical refresh cannot open paper/live capital by itself;
- options-dependent quotes stay discounted while options catalog `/readyz` has `ready=false`;
- Jangar `external_capital` holds are visible as platform proof debt.

## Rollout Plan

1. **Shadow ledger:** emit ledgers and quotes without changing scheduler behavior.
2. **Route parity:** expose the same digest through status, health, runtime profitability, scheduler snapshots, and
   Jangar projections.
3. **Proof selection:** allow selected zero-notional repair work to run from the ledger.
4. **Closure and falsification:** close, downgrade, or falsify hypothesis debt only from matching proof outputs.
5. **Capital integration:** require closed proof debt plus fresh order warrants before any paper/live notional.

## Rollback Plan

Rollback should preserve evidence:

- disable proof-selection scheduling before disabling ledger emission;
- keep historical ledgers, quotes, selected repair classes, and closure outcomes;
- return broker admission to the prior profit evidence lease and order warrant policy;
- publish the last ledger digest and every quote that was ignored by rollback.

## Risks and Tradeoffs

The main risk is false precision. A quote score can make weak evidence look quantitative. The first implementation
must use coarse buckets and show penalties explicitly.

The second risk is proof-work sprawl. If every hypothesis buys every repair, we have reinvented broad retries. The
market maker must cap selected quotes per session and prefer proof that can close global blockers.

The tradeoff is slower paper reentry. I accept that because the current system has no recent executions, old TCA, stale
empirical jobs, and a degraded live health path. Proof liquidity gives us a way to learn without pretending capital is
ready.

## Handoff Contract

Engineer acceptance gates:

- implement shadow ledgers and hypothesis proof quotes from current route inputs;
- add route parity tests for status, health, runtime profitability, scheduler snapshots, and broker admission;
- add May 5 fixtures covering stale empirical jobs, zero executions, old TCA, options readiness false, quant-health
  timeout, and Jangar action holds;
- prove selected quotes default to zero notional.

Deployer acceptance gates:

- do not promote paper/live capital while the ledger reports high-severity proof debt or only zero-notional quotes;
- capture ledger digest, selected quotes, penalties, closure state, and rollback target in release handoffs;
- verify enforcement can be disabled without hiding proof demand.

Jangar acceptance gates:

- publish evidence liquidity receipts and actionability buckets with stable digests;
- expose `external_capital` holds separately from serving readiness;
- keep stale digest quarantine visible so Torghut can discount platform proof without needing privileged SQL or
  cluster-admin reads.
