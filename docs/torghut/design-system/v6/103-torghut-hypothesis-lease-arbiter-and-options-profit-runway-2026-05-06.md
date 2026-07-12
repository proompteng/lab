# 103. Torghut Hypothesis Lease Arbiter And Options Profit Runway (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: options data/control lane exists; options trading authority remains separate and gated.
- Matched implementation area: Options lane.
- Current source evidence:
  - `services/torghut/app/options_lane/settings.py`
  - `services/torghut/app/options_lane/catalog_service.py`
  - `services/torghut/app/options_lane/enricher_service.py`
  - `argocd/applications/torghut-options/ws/deployment.yaml`
  - `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
- Design drift note: March/options text must be checked against current `options_lane` source and `torghut-options` GitOps before use.


## Decision

I am choosing a **hypothesis lease arbiter with an options profit runway** for Torghut.

Torghut is operationally alive but economically under-proven. The current live and simulation revisions are running,
ClickHouse has fresh equity TA data through the May 5 market close, and the chip universe is constrained. Those are
real positives. The negatives are stronger for capital: Postgres has no active `research_candidates`,
`research_promotions`, `autoresearch_epochs`, `autoresearch_candidate_specs`, `strategy_promotion_decisions`, or
`vnext_promotion_decisions`; `trade_decisions` is dominated by rejected and blocked statuses; executions have not been
fresh since April 2; and the options feature tables are structurally present but empty.

The selected architecture makes every capital step earn a short-lived hypothesis lease. A route, a running pod, or a
fresh TA table is not a capital decision. A hypothesis lease is. It names the strategy family, account/window, data
sources, net-edge measurement, rejection drag, drawdown limit, and rollback trigger. Jangar consumes the compact result
through its evidence-lease rollout arbiter.

The tradeoff is that Torghut will spend time on zero-notional and paper proof before live capital reentry. I accept
that because profitability is not improved by submitting faster into a system whose durable evidence says rejection and
blocked decisions are the dominant outcomes.

## Evidence Snapshot

All cluster and database assessment was read-only. No Kubernetes resources, database rows, or trading controls were
changed.

### Cluster And Rollout Evidence

- `kubectl get pods -n torghut -o wide` showed live revision `torghut-00228-deployment-6cfbd4d7b8-twfnn` at
  `2/2 Running` and simulation revision `torghut-sim-00309-deployment-65b8769f9-kkc7h` at `2/2 Running`.
- ClickHouse, Keeper, Torghut Postgres, TA, TA sim, options catalog, options enricher, options TA, websocket services,
  Alloy, and guardrail exporters were running.
- Torghut events during the current rollout included transient startup and readiness probe failures before
  `RevisionReady`, plus expected old-revision 503s during shutdown.
- Argo CD reported `torghut`, `torghut-options`, and `symphony-torghut` as `Synced` and `Healthy`.
- The live Torghut environment still carries capital-conservative controls: `TRADING_SIMPLE_SUBMIT_ENABLED=false`,
  `TRADING_AUTONOMY_ENABLED=false`, `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`,
  `TRADING_EVIDENCE_CONTINUITY_ENABLED=false`, `TRADING_EMPIRICAL_JOBS_HEALTH_REQUIRED=false`, and
  `TRADING_JANGAR_QUANT_HEALTH_REQUIRED=false`.

### Postgres Evidence

- Torghut SQL connected as `torghut_app` to database `torghut` at `2026-05-06T02:25:30.460Z`; table count was 69.
- `trade_decisions` had 147,606 rows, newest `created_at` at `2026-05-04T17:25:57.901Z`, and newest `executed_at` at
  `2026-04-02T20:59:45.140Z`.
- `trade_decisions` status distribution was 69,909 `rejected`, 63,552 `blocked`, 13,555 `filled`, 370 `planned`,
  217 `canceled`, and 3 `expired`.
- `executions` had 13,555 `filled`, 220 `canceled`, and 3 `expired`; newest `last_update_at` was
  `2026-04-03T05:32:38.761Z`.
- `research_runs` contained only 48 `skipped` rows, newest update `2026-03-11T10:14:45.327Z`.
- `research_candidates`, `research_promotions`, `autoresearch_epochs`, `autoresearch_candidate_specs`,
  `strategy_promotion_decisions`, and `vnext_promotion_decisions` returned no rows.
- `vnext_empirical_job_runs` had 16 completed empirical-authority rows, newest update `2026-03-21T09:03:22.150Z`.
- `whitepaper_analysis_runs` had one completed row from March; `whitepaper_semantic_embeddings` had 254 rows, newest
  at `2026-04-26T20:53:46.984Z`.

### ClickHouse Evidence

- ClickHouse version was `25.3.6.10034.altinitystable`.
- `ta_microbars` had 1,676,707 rows across 20 symbols, newest `event_ts` at `2026-05-05 20:59:07.000` and newest
  `ingest_ts` at `2026-05-05 20:59:32.732`.
- `ta_signals` had 1,163,484 rows across 20 symbols, newest `event_ts` at `2026-05-05 20:59:07.000` and newest
  `ingest_ts` at `2026-05-05 20:59:32.732`.
- `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` all had zero rows. Their
  max event/ingest timestamps defaulted to the epoch, which is a hard absence signal for options strategy proof.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already has the right admission vocabulary: dependency quorum,
  empirical jobs, quant health, certificate evidence, capital stage, and reason codes.
- `services/torghut/app/trading/hypotheses.py` defines runtime hypothesis state, capabilities, rollback requirements,
  and capital stages, but the durable hypothesis and promotion tables are empty.
- `services/torghut/app/trading/discovery/promotion_contract.py`,
  `services/torghut/app/trading/discovery/validation.py`, and `services/torghut/scripts/verify_quant_readiness.py`
  provide proof primitives that should produce lease evidence instead of remaining disconnected scripts.
- Options services have live pods and schemas, but the ClickHouse options feature tables have no rows. Options work
  must therefore start as a data runway, not a paper-capital strategy.
- Jangar can provide the companion `torghut_profit` lease only when Torghut publishes compact hypothesis decisions.

## Problem

Torghut has a profitability proof gap, not just an operational readiness gap.

1. **Running routes are not profit evidence.** Current pods and services can be healthy while hypothesis proof tables
   are empty.
2. **Fresh equity TA does not cover options.** Equity TA data is fresh; options feature tables are empty.
3. **Historical decision drag is material.** Rejected plus blocked decisions outnumber filled decisions by roughly ten
   to one. Any capital gate that ignores that distribution is optimistic.
4. **Research is not producing durable candidates.** Skipped research rows and empty promotion rows cannot justify
   capital.
5. **Jangar needs compact semantics.** Jangar should consume a small lease decision, not scrape Torghut's local tables
   and infer capital risk.

## Alternatives Considered

### Option A: Stay In Shadow Until Manual Review Clears Capital

Pros:

- Safest immediate posture.
- Requires little new implementation.
- Matches the current absence of durable proof.

Cons:

- Does not define how a strategy earns paper capital.
- Keeps profitability dependent on manual interpretation.
- Does not create a durable contract Jangar can consume.

Decision: reject as the target architecture. Manual review remains an exception and rollback tool.

### Option B: Promote Equity-Only Candidates From Fresh TA

Pros:

- Uses the healthiest current data plane: `ta_microbars` and `ta_signals`.
- Can start with the constrained chip universe.
- Avoids waiting for options data to fill.

Cons:

- Does not address the rejection/blocked decision distribution.
- Does not prove paper/live broker behavior after April 2.
- Leaves options innovation stalled.
- Can recreate the exact historical failure mode: fresh signals but poor actuation.

Decision: use equity TA as one input to shadow repair, not as direct capital authority.

### Option C: Hypothesis Lease Arbiter And Options Profit Runway

Torghut publishes one expiring lease per hypothesis/account/window. The lease joins data freshness, proof sample,
expected edge, cost model, rejection drag, risk, and rollback readiness. Options work starts with a runway that must
fill data tables before paper capital is even considered.

Pros:

- Converts profitability into a measurable, auditable contract.
- Gives Jangar a compact consumer decision.
- Keeps shadow repair open while paper/live fail closed.
- Lets options work innovate without pretending empty data is proof.
- Prices rejection drag before capital is admitted.

Cons:

- Requires new projection and tests.
- Slows paper/live reentry.
- Requires clear lease expiry and retention rules.

Decision: select Option C.

## Chosen Architecture

### HypothesisLease

Torghut emits a lease for every capital-relevant hypothesis:

```text
hypothesis_lease
  lease_id
  hypothesis_id
  strategy_family
  account
  window_start
  window_end
  generated_at
  fresh_until
  producer_revision
  data_lease_ids[]
  proof_sample
  expected_gross_edge
  expected_net_edge
  rejection_drag
  slippage_bps
  drawdown
  guardrail_decision        # observe_only, shadow_repair, paper_allowed, live_allowed, blocked
  reason_codes[]
  rollback_triggers[]
  artifact_refs[]
```

Every lease must be cheap to read, bounded in size, and safe for Jangar to consume.

### DataReadinessLease

Data readiness is separate from hypothesis proof:

```text
data_readiness_lease
  lease_id
  source                  # equity_ta, options_bars, options_features, market_context, broker_order_feed
  symbols
  rows
  newest_event_ts
  newest_ingest_ts
  freshness_seconds
  coverage_ratio
  decision                # allow, observe_only, repair_only, hold, block
  missing_inputs[]
```

Current initial decisions:

- `equity_ta=allow` for shadow repair, because `ta_microbars` and `ta_signals` are fresh through the May 5 market
  close.
- `options_bars=block`, `options_features=block`, and `options_surface=block`, because all three options ClickHouse
  tables have zero rows.
- `broker_order_feed=hold` for paper/live, because executions have no fresh activity after April 3.

### Hypothesis Lease Arbiter

The arbiter maps leases to capital:

- `observe_only`: route, UI, and diagnostics.
- `shadow_repair`: zero-notional hypothesis replay, feature repair, and proof generation.
- `paper_capital_allowed`: paper broker orders only after a fresh hypothesis lease passes.
- `live_capital_allowed`: real capital only after paper evidence, rollback readiness, and Jangar rollout admission are
  fresh.
- `blocked`: any missing required data, stale proof, or violated guardrail.

Default current posture:

- Equity chip intraday strategies may run shadow repair.
- Options strategies are data-runway only until options tables carry current rows and coverage.
- Paper capital is held.
- Live capital is blocked.

## Measurable Hypothesis Program

The first three hypotheses should be explicit and falsifiable.

### H1: Chip Equity Rejection-Drag Repair

Hypothesis: constrained chip-universe equity signals can produce positive net edge only if rejection drag is reduced
below the paper/live gate.

Measurements:

- universe: `NVDA, TSM, AVGO, MU, AMD, ASML, INTC, LRCX, AMAT, TXN, ARM, KLAC`;
- sample: at least five trading sessions or an approved replay equivalent;
- rejection ratio below 1 percent for paper admission;
- expected net edge after fees and slippage greater than zero;
- max drawdown under the configured rollback threshold;
- broker order feed proof fresh within the lease window.

Capital decision: shadow repair now; paper only after a fresh lease proves the rejection target.

### H2: Options Surface Bootstrap

Hypothesis: options features can improve risk-adjusted returns only after a minimum surface coverage runway is present.

Measurements:

- `options_contract_bars_1s` rows greater than zero for the target contracts;
- `options_contract_features` rows greater than zero with freshness under the lease window;
- `options_surface_features` coverage ratio above the configured threshold;
- quote-quality pass rate and spread cap present in the lease;
- no paper orders while any options data lease is `block`.

Capital decision: data runway only now; no paper or live options capital.

### H3: Market Context Freshness As A Trade Filter

Hypothesis: market-context freshness can reduce false positives in the chip universe without suppressing profitable
signals.

Measurements:

- market context domain freshness for technicals, news, fundamentals, and regime;
- shadow replay comparison against a TA-only baseline;
- false-positive reduction and missed-edge cost;
- no regression in rejection ratio.

Capital decision: shadow repair until a lease shows net improvement against the baseline.

## Engineer Scope

1. Add `HypothesisLease`, `DataReadinessLease`, and arbiter builders in the Torghut trading/proof layer.
2. Populate leases from existing Postgres and ClickHouse reads without writing on request paths.
3. Expose a compact read-only status route for Jangar consumption, for example
   `/trading/proof/hypothesis-leases/current`.
4. Add tests proving route liveness plus empty hypothesis tables returns `paper=hold` and `live=block`.
5. Add tests proving fresh equity TA permits only shadow repair when rejection drag is unresolved.
6. Add tests proving zero-row options tables block options paper/live capital.
7. Wire the companion Jangar `torghut_profit` lease to consume the compact Torghut decision.

## Deployer Scope

1. Deploy lease projection in shadow/read-only mode first.
2. Verify the route returns current data leases for equity TA, options, broker feed, and research proof.
3. Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and live capital blocked until paper leases pass.
4. Enable paper only for a named hypothesis/window after the lease includes required measurements and rollback triggers.
5. Do not enable live capital until paper evidence is fresh, Jangar rollout admission is `allow`, and rollback readiness
   is explicit.

## Validation Gates

Engineer acceptance gates:

- Unit: empty `research_candidates`, `research_promotions`, and `strategy_promotion_decisions` produce
  `paper=hold`, `live=block`.
- Unit: zero-row options data leases produce `options=block`.
- Unit: fresh equity TA with stale broker executions produces `shadow_repair=allow`, `paper=hold`.
- Unit: rejection ratio above threshold blocks paper/live even when signal data is fresh.
- Integration: Jangar can parse the compact Torghut lease payload and map it to `torghut_profit`.

Deployer acceptance gates:

- `kubectl get pods -n torghut` shows current live, sim, options, TA, Postgres, and ClickHouse pods ready.
- Argo apps `torghut` and `torghut-options` stay `Synced` and `Healthy`.
- ClickHouse equity TA freshness is current for the market session being evaluated.
- Options data leases remain `block` until the zero-row tables are populated.
- Paper/live capital remains held when hypothesis proof tables are empty.
- Any paper admission cites a lease id, window, account, evidence digest, rollback trigger, and Jangar admission
  decision.

## Rollout

- Start with shadow projection only; no trading behavior changes.
- Add Jangar consumption after the Torghut lease payload is stable.
- Enable paper-capital admission for one equity hypothesis and one account/window only after H1 gates pass.
- Keep options in data-runway mode until H2 data-readiness gates pass.
- Enable live capital only after a paper lease remains fresh through the configured stability window and rollback
  readiness is verified.

## Rollback

- If the lease route fails or becomes stale, Jangar must treat `torghut_profit` as `block` for paper/live and
  `repair_only` for shadow.
- If paper orders regress rejection ratio, return the hypothesis to `shadow_repair` and freeze further paper admission.
- If options data freshness regresses, keep options at data-runway only; do not roll back equity shadow repair unless
  shared dependencies degrade.
- If Jangar rollout admission becomes `hold` or `block`, Torghut must not widen capital even if local leases pass.
- Roll back live capital by restoring the prior GitOps promotion or disabling the capital feature flags; do not mutate
  broker or database state manually from the workspace.

## Risks And Tradeoffs

- The arbiter may initially look like more paperwork. It must replace ambiguous capital toggles, not sit beside them.
- Empty options tables are a hard block for options capital. That slows the most novel path, but it prevents pretending
  schema equals data.
- Fresh equity TA can tempt a shortcut. The rejection-drag gate exists because past durable decisions show the shortcut
  is expensive.
- Lease queries must be bounded. They should read summaries and materialized status, not scan large trading tables on
  hot routes.
- A good local Torghut lease is necessary but not sufficient. Jangar rollout admission remains the cross-plane authority
  for widening.

## Handoff Contract

Engineer:

- Build compact leases from existing Torghut proof, data, and trading tables.
- Add tests for empty durable proof, zero-row options data, stale executions, and rejection drag.
- Expose a stable read-only route for Jangar and document its schema.
- Keep all initial behavior shadow/read-only until deployer gates pass.

Deployer:

- Keep paper/live capital closed until named hypothesis leases pass.
- Validate equity TA, broker feed, and research proof freshness before paper.
- Validate options rows and coverage before options paper.
- Treat stale or missing Jangar `torghut_profit` admission as a fail-closed paper/live decision.
