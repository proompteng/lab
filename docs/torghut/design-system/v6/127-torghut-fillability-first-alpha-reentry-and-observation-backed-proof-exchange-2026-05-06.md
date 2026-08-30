# 127. Torghut Fillability-First Alpha Reentry And Observation-Backed Proof Exchange (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

Torghut will move to a **fillability-first alpha reentry loop** backed by Jangar observation receipts before any
hypothesis leaves shadow.

The system is running but not profitable in its current state. `/healthz` is OK, Postgres and ClickHouse checks are OK,
Alpaca broker status is OK for the live account, the scheduler is running, schema head is current, and the Jangar quant
store is producing fresh latest metrics. At the same time `/readyz` is HTTP 503 because live submission is blocked by
`simple_submit_disabled`; alpha readiness has three hypotheses, all at shadow or blocked, all rollback-required, and
dependency quorum is blocked by degraded empirical jobs. Today has zero decisions and zero fills. The most recent
meaningful trading day sample I observed, `2026-05-04`, had eight generated decisions and eight rejections, all tied to
insufficient buying power, with zero fills. Empirical proof is stale from March 21.

The selected design does not ask the system to search for more alpha first. It asks the system to prove that an
otherwise attractive signal can become an executable, funded, risk-bounded intent before Jangar spends repair capacity
or Torghut requests paper capital. Every hypothesis reentry candidate must publish a fillability receipt, a fresh
empirical proof receipt, and a Jangar observation-backed material-action verdict.

The tradeoff is that paper reentry becomes slower and more procedural. I accept that. Profitability improves when we
stop treating rejected orders, missing empirical proof, and stale quant windows as operational noise and instead use
them as the first optimization target.

## Runtime Objective And Success Metrics

This contract increases Torghut profitability by making the next reentry step measurable, not merely enabled.

Success means:

- Shadow lanes continue producing zero-notional intents even while live submission remains disabled.
- Each intent records fillability, buying-power outcome, slippage budget, expected edge, broker/account scope, and
  Jangar observation verdict.
- No hypothesis can request paper capital without fresh empirical proof and an `allow_shadow` or better Jangar verdict.
- Insufficient-buying-power rejections become a scored sizing input, not a repeated runtime surprise.
- Engineer and deployer stages can prove that current degraded evidence keeps capital shadow-only.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, trading flags, broker
state, or GitOps resources.

### Cluster And Runtime Evidence

- Torghut live revision `torghut-00239` and simulation revision `torghut-sim-00334` were running.
- Torghut options catalog, options enricher, options TA, live TA, sim TA, websockets, ClickHouse, Keeper, Postgres,
  guardrail exporters, Alloy, and Symphony pods were running.
- Argo CD reported `torghut` as `OutOfSync` and `Healthy`, while `torghut-options` was `Synced` and `Healthy`.
- Recent Torghut events showed readiness 503s, Flink status conflict churn, and duplicate ClickHouse PDB matches.
- Direct CNPG, Secret, Knative, and pod exec reads were forbidden for this service account, so database/data evidence
  was taken from application-owned read-only projections and the RBAC denial is treated as an observation gap.
- `GET /healthz` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `GET /readyz` returned HTTP 503 with scheduler OK, Postgres OK, ClickHouse OK, Alpaca OK, database schema current,
  universe OK from Jangar cache, empirical jobs authority blocked, live submission gate blocked, and quant evidence not
  configured for the local Torghut submission path.

### Trading And Data Evidence

- `/trading/status` reported `mode=live`, active revision `torghut-00239`, `market_session_open=true`,
  `active_capital_stage=shadow`, three hypothesis manifests, one blocked and two shadow, zero promotion eligible, and
  three rollback-required hypotheses.
- Critical toggles were aligned: trading enabled, autonomy live promotion disabled, kill switch disabled, and mode live.
- Empirical jobs were degraded and authority blocked. `benchmark_parity`, `foundation_router_parity`, `janus_event_car`,
  and `janus_hgrm_reward` were truthful and promotion-eligible when created, but stale from `2026-03-21T09:03:22Z`.
- `/api/torghut/trading/summary?day=2026-05-06` showed zero generated decisions, zero filled executions, realized PnL
  0, and account equity around `35385.97` through the sampled window.
- The same summary exposed runtime profitability over a 72-hour lookback with `decisionCount=8`, `executionCount=0`,
  `tcaSampleCount=0`, and caveats `evidence_only_no_profitability_certainty` and
  `realized_pnl_proxy_from_tca_shortfall`.
- `/api/torghut/trading/summary?day=2026-05-04` showed eight generated decisions, zero fills, and eight rejected
  submissions. Sample rejected decision `9ac283c1-c0b7-48f3-bd37-2e56613815f9` for `AMD` under
  `microbar-volume-continuation-long-top2-v11` had risk reason `insufficient_buying_power`.
- Jangar quant health was OK with fresh updates and 3780 latest metrics. A scoped 5-day snapshot for strategy
  `db327e20-4d37-45f3-bf18-5c51e844de31` had 36 metrics, one matching open alert, zero autoresearch epochs, and several
  insufficient-data metrics. Open quant alerts counted 37 critical and 13 warning.
- Database schema readiness from `/readyz` reported Alembic head `0029_whitepaper_embedding_dimension_4096`, current
  schema signature `3c1a76a911bc0a1af7d88d931bd53837ef1d5a4b0eac48c9b690317f3e76756d`, lineage ready, and known
  parent-fork warnings.

### Source Evidence

- `services/torghut/app/main.py` is 4051 lines and owns health, readiness, trading status, empirical jobs, runtime
  profitability, and submission surfaces.
- `services/torghut/app/trading/submission_council.py` is 1196 lines and already combines hypothesis runtime state,
  dependency quorum, empirical job readiness, typed quant health, TCA, critical toggles, and capital stage.
- `services/torghut/app/trading/hypotheses.py` is 732 lines and loads three source-controlled runtime manifests:
  `H-CONT-01`, `H-REV-01`, and `H-MICRO-01`.
- `services/torghut/app/trading/empirical_jobs.py` is 561 lines and already encodes truthfulness, lineage, stale
  status, and promotion-authority eligibility.
- `services/torghut/app/trading/profitability_archive.py` is 1532 lines and represents the historical proof archive
  lane, but current runtime data shows no fills to validate today's reentry.
- The test suite has broad coverage across empirical jobs, submission council, options lane, hypothesis governance,
  profitability evidence, order firewall, runtime windows, and quant readiness. The missing regression is not a unit
  boundary; it is a system contract that turns rejected and unfilled intents into fillability proof before capital.

## Problem

Torghut has signal machinery, broker connectivity, fresh enough route evidence, and fresh Jangar quant materialization.
It does not yet have proof that signals can become executable profit under current capital, buying-power, slippage, and
control-plane observation constraints.

The current state proves the gap:

1. Live readiness is degraded because capital submission is intentionally disabled.
2. Runtime hypotheses exist, but all are shadow or blocked and all require rollback.
3. Empirical proof is stale by weeks.
4. Today's decision and execution ledgers are empty.
5. The most recent decision sample produced eight buying-power rejections and zero fills.
6. Quant metrics are fresh at the store level but include many open critical alerts and insufficient-data windows.

If we optimize for "enable trading" before we optimize for "prove fillability", the next capital step will likely
recreate the May 4 rejection pattern. That is not innovation; it is repeatedly discovering that the execution path is not
funded or measured.

## Alternatives Considered

### Option A: Reenable Paper/Live Submission After Empirical Proof Refresh

This option treats stale empirical jobs as the main blocker. Once proof is fresh, Torghut can move a canary out of
shadow.

Pros:

- Directly addresses the dependency quorum block.
- Reuses existing empirical job contracts.
- Easy for deployer to reason about.

Cons:

- Does not explain the eight buying-power rejections.
- Does not use fresh quant alerts as a capital brake.
- Can refresh proof and still submit orders that fail fillability.

Decision: reject as sufficient. Empirical refresh is necessary, but not enough.

### Option B: Focus On New Alpha Search And Keep Capital Shadowed

This option spends the next cycle on better alpha candidates while current execution remains shadow-only.

Pros:

- Keeps capital safe.
- May improve expected edge.
- Uses existing profitability frontier and autoresearch tooling.

Cons:

- Avoids the execution bottleneck.
- Adds candidates to a system that cannot yet prove fillability.
- Lets stale empirical proof and rejected intents remain unpriced.

Decision: reject as the next architecture increment. Search stays useful, but fillability must become the first gate.

### Option C: Fillability-First Alpha Reentry With Observation-Backed Proof Exchange

This option turns every shadow signal into a zero-notional capital intent, scores whether it could be funded and filled,
binds that score to empirical and quant evidence, and requires a Jangar material-action verdict before paper capital.

Pros:

- Directly attacks the observed insufficient-buying-power failure.
- Keeps live broker mutation disabled while producing measurable proof.
- Gives Jangar a compact Torghut proof object to admit or hold.
- Links hypothesis, account, edge, slippage, quant alert state, and observation receipts.
- Allows profitable repair work without pretending capital is ready.

Cons:

- Adds a new ledger and proof exchange.
- Slows paper reentry until zero-notional proof is convincing.
- Requires careful separation between "could submit" and "did submit" evidence.

Decision: select Option C.

## Architecture

### CapitalIntentLedger

Torghut creates a zero-notional ledger entry for each candidate action that would otherwise be submitted.

```text
capital_intent_ledger
  intent_id
  generated_at
  expires_at
  hypothesis_id
  strategy_id
  strategy_family
  account
  symbol
  side
  intended_qty
  intended_notional
  broker_account_equity
  buying_power_required
  buying_power_available
  buying_power_decision          # pass, shrink, reject, unknown
  expected_gross_edge_bps
  expected_slippage_bps
  expected_net_edge_bps
  quant_alert_state
  empirical_proof_state
  jangar_verdict_ref
  decision                       # shadow_observe, repair_only, paper_candidate, blocked
  reason_codes[]
```

No broker order is submitted from this ledger. It is a proof object used to decide whether a real paper canary is worth
admitting later.

### FillabilityProofExchange

Torghut publishes a compact proof exchange for Jangar:

```text
fillability_proof_exchange
  exchange_id
  generated_at
  fresh_until
  schema_head
  account
  hypothesis_id
  intent_count
  fillability_pass_rate
  shrink_rate
  buying_power_reject_rate
  expected_net_edge_bps_p50
  expected_net_edge_bps_p10
  quant_critical_alert_count
  empirical_proof_age_seconds
  latest_decision_at
  latest_execution_at
  capital_reentry_decision       # shadow_only, repair_only, paper_candidate, blocked
  rollback_triggers[]
  observation_receipt_refs[]
```

Jangar consumes this through the companion material-action verdict. Torghut may not move a hypothesis beyond
`shadow_only` unless Jangar's verdict is fresh and at least `allow_shadow`.

### Measurable Trading Hypotheses

`H-CONT-01` intraday continuation:

- Hypothesis: continuation signals with fresh TA and no buying-power shrink can produce positive post-cost expectancy
  after a 12 bps slippage budget.
- Shadow sample gate: at least 200 zero-notional intents across five market sessions.
- Paper candidate gate: fillability pass rate at least 95%, buying-power reject rate 0 over the most recent 30 intents,
  expected net edge p10 greater than 0 bps, and empirical proof refreshed within 24 hours.
- Rollback: any critical quant alert on the target strategy/window, signal lag above 90 seconds, or realized slippage
  above 12 bps in paper returns to shadow.

`H-REV-01` event reversion:

- Hypothesis: event reversion only has edge when market context is fresh and the Jangar universe dependency is healthy.
- Shadow sample gate: at least 100 zero-notional intents with market-context freshness at or below 120 seconds.
- Paper candidate gate: expected net edge p50 at least 3 bps, no stale market-context receipt, and no dependency quorum
  block.
- Rollback: market context stale, empirical proof older than 24 hours, or drawdown greater than 120 bps.

`H-MICRO-01` microstructure breakout:

- Hypothesis: microstructure breakout can beat costs only when order-book liquidity and microstructure features are
  present and quote freshness is tight.
- Shadow sample gate: blocked until required feature coverage exists and quote/options freshness is at or below 15
  seconds for the target sample.
- Paper candidate gate: fillability pass rate at least 98%, expected slippage p90 below 8 bps, and zero critical quant
  alerts.
- Rollback: feature coverage missing, drift checks missing, or any insufficient-data quant metric used by the sizing
  model.

## Implementation Scope

Engineer stage should implement:

- `capital_intent_ledger` persistence or a first-class projection over existing decisions and execution-policy checks;
- zero-notional buying-power and sizing simulation that records pass, shrink, reject, and unknown outcomes without
  sending broker orders;
- fillability proof exchange materialization keyed by account, hypothesis, and window;
- a Jangar material-action verdict client in `submission_council.py`;
- tests for May 4-style insufficient-buying-power rejection, shadow-only current state, stale empirical jobs, critical
  quant alerts, and Jangar verdict hold;
- a migration/backfill path that can seed proof exchange entries from existing rejected decisions without changing
  trading state.

Deployer stage should implement:

- read-only route checks for `/readyz`, `/trading/status`, Jangar quant health, and Jangar material-action verdict;
- dashboards for fillability pass rate, buying-power reject rate, expected net edge, empirical proof age, and capital
  reentry decision;
- alerting when shadow intent volume drops to zero during market hours or buying-power reject rate exceeds 0 for a paper
  candidate;
- feature flags that keep broker order submission disabled while capital intent proof is shadow-only.

## Validation Gates

Before engineer completion:

- A regression fixture with eight insufficient-buying-power decisions produces `buying_power_reject_rate > 0` and
  `capital_reentry_decision=blocked`.
- Current degraded empirical jobs force `empirical_proof_state=stale` and prevent paper candidates.
- Current critical quant alerts prevent paper/live capital even when runtime kits are healthy.
- `H-CONT-01`, `H-REV-01`, and `H-MICRO-01` each emit a hypothesis-specific gate result.
- The proof exchange never submits an Alpaca order.

Before deployer completion:

- `/readyz` may remain HTTP 503 while `capital_intent_ledger` proof generation is healthy.
- Today with zero decisions/fills reports shadow proof starvation rather than paper readiness.
- A fresh Jangar observation verdict is required for paper candidate status.
- Argo `torghut OutOfSync` blocks rollout/capital widening but does not block shadow proof collection.

## Rollout Plan

1. Shadow ledger only: write capital intents for all would-be submissions and do not change broker behavior.
2. Proof exchange: publish fillability summaries to Jangar and expose them through the Torghut status surface.
3. Repair admission: let Jangar allocate repair capacity to the highest expected-net-edge proof gaps.
4. Paper candidate mode: allow paper canary only when empirical proof, fillability, quant alerts, and Jangar observation
   verdict agree.
5. Live micro-canary: only after paper slippage, TCA, drawdown, and rollback receipts satisfy the live-capital quorum.

## Rollback Plan

Rollback is conservative:

- Disable proof exchange consumption and keep writing shadow intents.
- Force all capital reentry decisions to `shadow_only`.
- Keep live submission disabled until empirical jobs and fillability proof recover.
- Retain the ledger for audit because it contains no broker mutations.

Emergency rollback trigger:

- Any proof exchange bug attempts to submit a broker order.
- Any paper candidate appears while empirical jobs are stale.
- Buying-power rejects appear after paper admission.
- Jangar observation verdict is stale or missing and Torghut still attempts to leave shadow.

## Risks And Mitigations

- **Risk: zero-notional simulation diverges from broker reality.** Mitigate by reconciling the first paper canary against
  actual broker rejection and TCA receipts before scale-up.
- **Risk: the system optimizes fillability and loses edge.** Mitigate by requiring expected net edge, not just pass rate.
- **Risk: stale empirical proof blocks too long.** Mitigate by letting repair capacity renew proof while capital remains
  shadow-only.
- **Risk: critical quant alerts are too coarse.** Mitigate by scoping alerts by strategy, account, and window before
  they block a specific hypothesis.
- **Risk: ledger volume grows during market hours.** Mitigate with per-hypothesis window aggregation and TTL for raw
  intent rows after proof exchange materializes.

## Handoff Contract

Engineer acceptance gates:

- Torghut emits capital-intent and fillability proof records without broker mutation.
- Proof records bind hypothesis, account, expected edge, buying-power outcome, empirical proof age, quant alert state,
  and Jangar verdict.
- Tests prove the current state remains shadow-only and the May 4 buying-power rejection pattern blocks paper reentry.

Deployer acceptance gates:

- Current production state shows `shadow_only` or `blocked`, never paper/live, while empirical jobs are stale and
  critical quant alerts are open.
- Shadow proof collection can run while `/readyz` is degraded by live submission being disabled.
- Rollback returns every hypothesis to shadow without database deletion or broker action.
