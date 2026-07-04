# 110. Torghut Evidence Freshness Repair Market And Capital Reentry (2026-05-06)

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

I am choosing an **EvidenceFreshnessRepairMarket** for Torghut capital reentry.

Torghut is alive but not profitable enough to widen. The latest live private revision answers `/readyz` and
`/trading/health` with structured degraded payloads. Scheduler, Postgres, ClickHouse, Alpaca, database schema, and
Jangar universe are OK. The capital facts are not OK: live submission is disabled by `simple_submit_disabled`, capital
stage is `shadow`, empirical jobs are degraded, there are three hypotheses with zero promotion eligibility and three
rollback-required states, and dependency quorum blocks on `empirical_jobs_degraded`.

The evidence defects are now specific enough to prioritize. Empirical jobs for `intraday_tsmom_v1@prod` are stale but
truthful. Jangar's global quant latest surface is fresh with 3,780 rows, but the scoped `paper/1d` query is empty and
must block paper/live action. Jangar market context is degraded with stale technicals, fundamentals, news, and regime.
The database schema is current, but direct SQL through CNPG exec is forbidden to the worker identity, so capital
readiness must consume service-owned proof rather than privileged database inspection.

The selected design treats proof repair like a market. Each stale or empty evidence domain becomes a repair order with
a cost, expected capital value, freshness target, and settlement receipt. Torghut spends repair budget first on the
evidence that can reopen the highest-value next action: quant latest rehydration, empirical replay, market-context
refresh, then TCA and expected-shortfall settlement. No hypothesis receives paper or live notional until its repair
orders settle and Jangar emits a fresh proof-repair clearance.

The tradeoff is that Torghut will stay shadow-only while the repair market catches up. I accept that because the current
system has service readiness, not capital evidence.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, broker settings, trading flags, or runtime objects were changed during this
assessment.

### Cluster And Runtime Evidence

- Torghut pods were running for ClickHouse, Keeper, Postgres, live and sim revisions, options catalog, options enricher,
  options TA, equity TA, simulation TA, websocket services, guardrail exporters, Symphony, and Alloy.
- Latest live `torghut-00233-deployment` was `1/1` available and its pod was `2/2 Running`.
- Latest simulation `torghut-sim-00314-deployment` was `1/1` available and its pod was `2/2 Running`.
- Recent Torghut events showed Knative live and sim revisions becoming ready after transient readiness probe failures.
- ClickHouse pods continued to produce multiple-PDB selection warnings, which should reduce deploy-widen confidence but
  not block proof repair.
- Agents namespace scheduling was active. Jangar discover, plan, implement, and verify schedules were creating and
  completing runs, with current Jangar stage clocks non-stale.

### Database And Data Evidence

- Direct CNPG SQL was blocked by RBAC: `pods/exec` is forbidden for both `jangar-db-1` and `torghut-db-1` to
  `system:serviceaccount:agents:agents-sa`.
- Torghut `/readyz` database check was current: expected and current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, and lineage ready.
- Torghut database projection still reports known parent-fork warnings for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` reported scheduler OK, Postgres OK, ClickHouse OK, Alpaca broker OK, database OK, and Jangar
  universe fresh with 12 symbols and zero cache age.
- Torghut `/readyz` and `/trading/health` returned HTTP 503 because capital readiness is degraded, not because core
  routes are unreachable.
- Empirical jobs were stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`, all persisted as truthful empirical authority and tied to
  `torghut-full-day-20260318-884bec35`.
- Jangar global quant health was current: `latestMetricsCount=3780`, `latestMetricsUpdatedAt` at
  `2026-05-06T08:08:48.271Z`, runtime enabled, runtime started, and missing update alarm false.
- Jangar scoped quant health for `account=paper&window=1d` was degraded: `latestMetricsCount=0`,
  `latestMetricsUpdatedAt=null`, and `emptyLatestStoreAlarm=true`.
- Jangar market-context health was degraded: `bundleFreshnessSeconds=128935`, `bundleQualityScore=0.4575`, and stale
  technicals, fundamentals, news, and regime domains.
- The NVDA context payload showed a concrete staleness pattern: technicals and regime from `2026-05-05T20:50:32Z`,
  fundamentals from `2026-03-12T13:43:18Z`, and news from `2026-03-16T13:37:07Z`.

### Source Evidence

- `services/torghut/app/main.py` is 4,051 lines and remains the broad route owner for readiness, trading health,
  empirical jobs, profitability runtime, TCA, market context, whitepaper, simulation, and live submission.
- `services/torghut/app/trading/submission_council.py` is 1,196 lines and is already the best local boundary for
  proof-aware capital decisions.
- `services/torghut/app/trading/hypotheses.py` owns hypothesis readiness, capital stages, dependency capabilities, and
  Jangar dependency quorum.
- `services/torghut/app/trading/empirical_jobs.py` owns empirical truthfulness and stale-job classification.
- `services/torghut/app/trading/market_context.py` owns market-context fetch and evaluation behavior, including stale
  and degraded last-good decisions.
- Torghut has 140 Python test files. Existing coverage includes market-context staleness, empirical jobs, hypothesis
  governance, trading health, submission council behavior, strategy factory, TCA, quote quality, and autonomy gates.
- The missing reducer is a capital-reentry repair market that ranks evidence repairs before any hypothesis can receive
  paper or live notional.

## Problem

Torghut's current state is a good example of why service readiness is not capital readiness.

The platform can reach Postgres, ClickHouse, Alpaca, Jangar universe, and the scheduler. That is useful. It does not
answer the trading question: which hypothesis can earn the next unit of capital, and what proof must be repaired first?

Today those blockers are spread across several surfaces:

1. empirical jobs are stale but truthful;
2. account/window quant latest is empty for `paper/1d`;
3. market-context domains are stale by session-relevant budgets;
4. TCA and expected-shortfall evidence still need to be current before live reentry;
5. the simple live submission lane is disabled;
6. database schema is current, but privileged SQL is not available to the worker lane.

Torghut needs to convert that evidence into an ordered repair plan. If it does not, the system either freezes forever or
reopens capital from route health alone.

## Alternatives Considered

### Option A: Keep Torghut Shadow-Only Until Operators Manually Repair Every Defect

Pros:

- Safe for capital.
- Requires no new reducer.
- Uses existing route diagnostics.

Cons:

- Does not prioritize repair.
- Wastes fresh global quant and options data.
- Makes the path back to paper/live dependent on manual interpretation.
- Does not create receipts that Jangar can consume before deploy widening.

Decision: reject as the operating model.

### Option B: Reopen Paper Capital As Soon As Core Dependencies Are OK

Use scheduler/Postgres/ClickHouse/Alpaca/database/universe readiness as the paper-capital threshold and keep empirical,
market-context, and scoped quant warnings informational.

Pros:

- Fastest path back to paper activity.
- Simple to implement.
- Takes advantage of healthy core routes.

Cons:

- Ignores the empty scoped quant latest store.
- Treats stale empirical authority as good enough.
- Lets stale market context into hypothesis evaluation.
- Repeats the failure mode of calling route readiness profit readiness.

Decision: reject.

### Option C: EvidenceFreshnessRepairMarket

Torghut turns each stale, empty, or missing proof into a repair order. It ranks repair by expected capital value,
freshness severity, confidence, and cost. Jangar proof-repair claims are consumed before sizing.

Pros:

- Gives a measurable route from shadow to paper and live micro-canary.
- Uses truthful stale empirical evidence as repairable debt instead of discarding it.
- Keeps fresh global quant data useful while requiring scoped account/window evidence for capital.
- Separates market-context refresh from empirical replay and quant rehydration.
- Gives Jangar and deployer stages settlement receipts.

Cons:

- Adds a repair market reducer and status projection.
- Requires care to avoid overfitting repair priority to one day's evidence.
- Keeps capital blocked longer than a route-only posture.

Decision: select Option C.

## Chosen Architecture

Torghut adds an `evidence_freshness_repair_market` that consumes Jangar proof repair claims and local proof state.

```text
evidence_freshness_repair_order
  order_id
  account_label
  hypothesis_id
  strategy_id
  evidence_domain                  # quant_latest, empirical_jobs, market_context, tca, execution_settlement
  subject_ref
  current_state                    # fresh, stale, empty, missing, degraded
  truthful
  stale_age_seconds
  max_freshness_seconds
  expected_capital_action_unblocked
  expected_edge_value_score
  repair_cost_score
  priority_score
  repair_lane                      # rehydrate, replay, refresh, settle, investigate
  jangar_claim_ref
  evidence_refs[]
  requested_at
  fresh_until
```

```text
capital_reentry_queue
  queue_id
  account_label
  generated_at
  repair_orders[]
  hypothesis_readiness[]
  capital_action_decisions[]       # shadow_only, repair_only, paper_canary, live_micro_canary, live_scale
  max_notional_by_action
  settlement_receipts[]
```

Initial repair lanes:

- `quant_latest_rehydrate`: rebuild account/window latest metrics and pipeline health for paper/live scoped queries.
- `empirical_replay`: refresh benchmark parity, foundation router parity, Janus event CAR, and Janus HGRM reward.
- `market_context_refresh`: refresh technicals, regime, news, and fundamentals by session-aware freshness budgets.
- `tca_settle`: recompute current TCA and expected-shortfall coverage before live action.
- `execution_settlement`: reconcile rejected/canceled/fill evidence into post-cost proof.

Priority scoring:

```text
priority_score =
  expected_capital_action_unblocked_weight
  + stale_age_weight
  + truthful_repairability_weight
  + expected_edge_value_score
  - repair_cost_score
  - route_pressure_score
```

Expected current ordering:

1. `quant_latest_rehydrate` for `paper/1d`, because the scoped latest store is empty and directly blocks paper/live.
2. `empirical_replay` for `intraday_tsmom_v1@prod`, because four proof jobs are truthful but stale.
3. `market_context_refresh`, starting with technicals and regime for session freshness, then news and fundamentals.
4. `tca_settle`, because live micro-canary needs current slippage and expected-shortfall coverage.
5. `execution_settlement`, because rejected/canceled evidence affects live scale but not the first repair step.

Capital action rules:

- `shadow_only` is allowed when repair orders are open and the strategy can generate zero-notional evidence.
- `repair_only` is allowed when the evidence domain has a bounded repair lane.
- `paper_canary` requires settled quant latest and empirical replay for the account/hypothesis tuple.
- `live_micro_canary` requires paper settlement plus current market context, TCA, expected-shortfall coverage, and
  Jangar live-capital clearance.
- `live_scale` requires positive post-cost evidence and no unresolved rollback debt.

## Measurable Trading Hypotheses

H-REPAIR-01, quant rehydration:

- Repair target: scoped `paper/1d` quant latest count is greater than zero during market hours, with
  `emptyLatestStoreAlarm=false` and pipeline-health scope present.
- Capital target: paper canary remains blocked until empirical replay settles, but quant rehydration removes the
  `quant_latest_empty` hard blocker.

H-REPAIR-02, empirical replay:

- Repair target: four empirical jobs for `intraday_tsmom_v1@prod` are refreshed within 24 hours of the repair order.
- Capital target: paper canary can enter comparison if quant latest is also fresh and hypothesis windows exist.

H-REPAIR-03, market-context freshness:

- Repair target: technicals and regime are within 120 seconds during active session; news is within 300 seconds unless
  degraded last-good is explicitly accepted; fundamentals are within 86,400 seconds.
- Capital target: live micro-canary remains blocked until market-context risk flags clear or are explicitly priced into
  shadow-only decisions.

H-REPAIR-04, TCA settlement:

- Repair target: expected-shortfall coverage is non-empty and slippage evidence is current for the candidate lane.
- Capital target: live micro-canary notional remains zero until TCA settlement passes.

## Implementation Scope

Engineer stage should:

1. Add a pure repair-market reducer under Torghut trading code, consuming Jangar proof repair claims and existing local
   readiness, empirical, market-context, quant, and TCA projections.
2. Add fixtures for the current live evidence: core dependencies OK, empirical stale, scoped quant empty,
   market-context stale, capital stage shadow, and zero promotion eligibility.
3. Emit repair-market decisions in shadow mode through a bounded status route.
4. Add tests proving fresh core dependencies are not enough for paper/live capital when scoped proof is empty or stale.
5. Add settlement receipt fixtures that Jangar can consume after repair.

Deployer stage should:

1. Deploy repair market in observe-only mode first.
2. Verify repair order ranking matches current evidence without widening capital.
3. Keep `paper_canary`, `live_micro_canary`, and `live_scale` fail-closed while repair orders are unresolved.
4. Allow `shadow_only` evidence generation and bounded repair jobs.
5. Roll back enforcement by flag while preserving repair orders and settlement receipts.

## Validation Gates

- A reducer test proves scheduler/Postgres/ClickHouse/Alpaca/database/universe OK plus stale empirical jobs yields
  `repair_only` or `shadow_only`, never paper/live allow.
- A reducer test proves global quant latest fresh plus scoped `paper/1d` empty blocks the scoped capital tuple.
- A reducer test proves market-context stale domains reduce live micro-canary to hold until repaired or explicitly
  accepted as degraded last-good shadow evidence.
- A contract test proves every repair order includes `fresh_until`, `priority_score`, `repair_lane`, `evidence_refs`,
  and a Jangar claim reference.
- A settlement test proves a repaired domain reopens only the action classes it actually supports.

## Rollout

1. Ship repair-market reducer and status projection in shadow mode.
2. Run one market-session comparison against existing `/readyz`, `/trading/health`, empirical jobs, market context, and
   Jangar quant health.
3. Enforce paper/live holds from the repair market while keeping shadow and repair lanes open.
4. Add settlement receipts and feed them back to Jangar's proof repair clearinghouse.
5. Consider paper canary only after quant latest, empirical replay, and hypothesis windows settle.

## Rollback

1. Disable repair-market enforcement with a flag.
2. Keep existing live submission gate and dependency quorum as the fail-closed capital path.
3. Preserve repair orders and receipts for audit.
4. Do not delete generated shadow evidence or replay artifacts during rollback.

## Risks

- Repair priority can overfit to the latest outage shape. Keep weights configurable and record the score inputs.
- Market-context repairs can become expensive if every symbol asks for full fundamentals and news refresh. Bound symbol
  count and domain count per repair order.
- Quant latest rehydration can hide deeper pipeline failures. Require a settlement receipt that includes pipeline-health
  scope, not only latest count.
- Empirical replay may prove the candidate is still unprofitable. That is a valid settlement outcome and should keep
  capital blocked.

## Handoff Contract

Engineer handoff:

- Build the reducer as a pure, fixture-driven component before integrating with scheduler decisions.
- Use Jangar proof repair claims as inputs, but keep local Torghut proof state authoritative for hypothesis economics.
- Add tests for the exact current blockers: stale empirical jobs, empty scoped quant latest, stale market context, and
  shadow capital stage.
- Do not widen paper/live capital in the first implementation PR.

Deployer handoff:

- Observe repair-market decisions for one market session before enforcement.
- Keep capital fail-closed when Jangar claim freshness is missing or stale.
- Permit shadow evidence and repair work while paper/live are held.
- Roll back enforcement by flag and preserve all repair receipts.
