# 105. Torghut Account-Scoped Hypothesis Liquidity And Options Bootstrap (2026-05-06)

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

I am choosing an **account-scoped hypothesis liquidity book with an options bootstrap lane** for Torghut.

The current system is operationally alive but not profit-authoritative. Live Torghut is running on revision
`torghut-00228`, sim is running on `torghut-sim-00309`, Postgres and ClickHouse checks are healthy, and the schema head
is current at `0029_whitepaper_embedding_dimension_4096`. That is the good news.

The capital story is still blocked. Live `/readyz` returns HTTP 503 because live submission is intentionally held by
`simple_submit_disabled`. Alpha readiness reports three hypotheses, zero promotion-eligible hypotheses, and three
rollback-required hypotheses. Empirical jobs are stale from `2026-03-21T09:03:22Z`. The live account
`PA3SX7FYNUTF` has stale quant latest metrics while generic Jangar metrics are fresh. ClickHouse equity TA has current
tables, but all options feature tables are empty. Torghut Postgres has 13,775 TCA metric rows but zero
`execution_order_events`, so broker-event reconciliation cannot yet close the loop.

The selected design turns that evidence into a capital router. Every hypothesis gets an account-scoped liquidity row
that says which proof is liquid, stale, missing, or blocked, and which lane can repair it. Equity strategies can keep
observe and repair authority. Options strategies enter a bootstrap lane until there are non-empty contract bars,
features, and surface features. No paper or live capital moves until the hypothesis can cite fresh account/window proof,
fresh empirical replay, and broker-event reconciliation.

The tradeoff is slower promotion and more explicit proof debt. I accept that because the fastest path to profitability
is not bypassing proof; it is making repair work specific enough to restore proof quickly.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, or trading settings were mutated.

### Cluster And Route Evidence

- `kubectl get pods -n torghut -o wide` showed `torghut-00228-deployment-6cfbd4d7b8-twfnn` and
  `torghut-sim-00309-deployment-65b8769f9-kkc7h` at `2/2 Running`.
- ClickHouse, Keeper, Torghut Postgres, options catalog, options enricher, equity TA, options TA, websocket, Alloy, and
  guardrail exporter pods were running.
- `kubectl get deployments -n torghut -o wide` showed live and sim active revisions on Torghut digest
  `sha256:158767dbfe9d6298700a6f048bff97160694e62eca363ddad36816cfafb620a2`, options services on the same Torghut
  digest, equity TA on digest `sha256:4d43f2a5c308cef923f66419c395903981127aedef919ff0e0c1b4fc895a4503`, and options
  TA on digest `sha256:9016052d30c4f06f9726e516b8048725f0f48c0fa64dcbeaac0e8993a5254a9b`.
- Recent Torghut events included multiple PodDisruptionBudget match warnings for ClickHouse pods and a Flink status
  update conflict warning for `torghut-options-ta`; both TA Flink REST endpoints still reported one running job and no
  failed tasks.
- Options catalog `/healthz` and `/readyz` returned HTTP 200. Options enricher `/healthz` and `/readyz` returned HTTP
  200 with a current `last_success_ts`.
- Live `/healthz` and `/trading/status` returned HTTP 200. Live `/readyz` and `/trading/health` returned HTTP 503 under
  the intentional no-live-submit posture.
- Simulation `/readyz` and `/trading/health` returned HTTP 200, but simulation quant evidence was degraded because
  latest metrics and pipeline stages were missing for `TORGHUT_SIM`.

### Database And Data Evidence

- CNPG pod exec was forbidden for this service account, so Postgres checks used read-only service connections.
- Torghut Postgres had 71 public tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- `vnext_empirical_job_runs` had 16 rows, with the latest update at `2026-03-21T09:03:22Z`.
- `execution_tca_metrics` had 13,775 rows, latest update `2026-04-03T05:32:36Z`.
- `execution_order_events` had zero rows. This is the key reconciliation gap: historical TCA exists, but live broker
  event closure is not active.
- `strategy_hypotheses`, `simulation_run_progress`, and `whitepaper_claims` were empty in the selected direct sample.
- ClickHouse `torghut.ta_microbars` had 1,676,707 rows with max event time `2026-05-05T20:59:07Z` and max ingest time
  `2026-05-05T20:59:32Z`.
- ClickHouse `torghut.ta_signals` had 1,176,729 rows with max event time `2026-05-05T20:59:07Z` and max ingest time
  `2026-05-06T02:34:17Z`.
- ClickHouse `torghut.options_contract_bars_1s`, `torghut.options_contract_features`, and
  `torghut.options_surface_features` had zero rows.
- Jangar `torghut_control_plane.quant_metrics_latest` had generic account rows fresh at `2026-05-06T04:15Z`, while
  live account `PA3SX7FYNUTF` rows were stale from `2026-05-05T17:26Z` through `2026-05-05T19:13Z`.

### Source Evidence

- `services/torghut/app/main.py` is 3,981 lines and composes readiness, trading status, empirical jobs, quant
  evidence, live submission gates, metrics, and trading APIs.
- `services/torghut/app/trading/autonomy/lane.py` is 7,377 lines and owns the largest autonomy/hypothesis runtime
  surface.
- `services/torghut/app/trading/submission_council.py` is 1,196 lines and already contains the vocabulary needed for
  capital stage, quant evidence, empirical readiness, promotion eligibility, and live submission gates.
- `services/torghut/app/trading/execution.py` is 1,612 lines; `order_feed.py` is 612 lines. The schema has
  `execution_order_events`, but the table is empty in production.
- Torghut has broad test coverage across trading API, empirical jobs, submission council, order feed, execution
  adapters, TCA, simulations, strategy runtime, and property tests. The missing coverage is an end-to-end proof of
  account-scoped capital admission: stale live-account proof, empty options tables, and empty broker events must
  combine into a deterministic hold with named rehydration lanes.

## Problem

Torghut has enough components to trade, but not enough current proof to promote capital.

1. Live operational health is not the same as account-scoped profit authority.
2. Generic Jangar quant metrics are fresh while the live account is stale.
3. Empirical jobs are truthful but expired.
4. Options services are ready, but options feature tables are empty.
5. TCA metrics exist, but broker-event reconciliation is empty.
6. The source code has the pieces spread across large modules; the promotion decision needs a compact artifact the
   broker, scheduler, Jangar, and deployer can all cite.

Without a hypothesis liquidity book, Torghut keeps re-discovering the same no-go state. The system needs to answer:
which hypothesis is closest to promotable, what exact proof is missing, what repair lane owns it, and what measurable
edge will justify paper or live capital?

## Alternatives Considered

### Option A: Keep Live Disabled Until Manual Proof Review

Pros:

- Safe today.
- Matches `simple_submit_disabled`.
- Avoids new projection work.

Cons:

- Does not repair stale empirical jobs.
- Does not distinguish equity proof debt from options proof debt.
- Leaves the next engineer without a measurable implementation target.

Decision: reject as the target architecture. Manual review remains a final approval gate, not the proof engine.

### Option B: Promote The Best Equity Hypothesis Once Jangar Is Healthy

Pros:

- Jangar platform state is now healthy enough to support controlled work.
- Equity TA tables are populated and current through the last market session.
- This is faster than building an options lane.

Cons:

- Live-account quant metrics are stale.
- Empirical replay is stale.
- Broker-event reconciliation is empty.
- It leaves options innovation blocked behind a later design.

Decision: reject as insufficient. Equity repair should proceed, but not by pretending the account proof is current.

### Option C: Account-Scoped Hypothesis Liquidity Book And Options Bootstrap

Pros:

- Converts each missing proof into a lane with owner, budget, and success metric.
- Lets equity and options progress without conflating their readiness.
- Gives Jangar a compact capital contract.
- Makes broker-event reconciliation a first-class promotion blocker.
- Creates a measurable profitability portfolio instead of one global live gate.

Cons:

- Adds a new projection and several reducer tests.
- Requires account identity normalization.
- Paper/live promotion waits for proof rather than route health.

Decision: select Option C.

## Chosen Architecture

### HypothesisLiquidityBook

Torghut should project one current row per hypothesis/account/window:

```text
hypothesis_liquidity_book
  hypothesis_id
  strategy_family
  account
  window
  capital_lane              # observe, repair, paper_candidate, live_candidate, blocked
  proof_state               # liquid, thin, stale, missing, contradictory, blocked
  expected_net_edge_bps
  expected_cost_bps
  rejection_drag_bps
  max_drawdown_bps
  empirical_job_refs[]
  quant_metric_ref
  broker_event_watermark
  options_data_watermark
  universe_ref
  proof_liquidity_ref       # Jangar record id
  rehydration_lane
  next_sample_contract
  fresh_until
  blocking_reason_codes[]
```

The book is not a dashboard summary. It is the admission artifact for scheduler, broker adapter, and Jangar.

### Initial Reducer Rules

- If live submission is `simple_submit_disabled`, no row can exceed `paper_candidate`, and live remains blocked.
- If account-scoped quant metrics are stale or missing, the lane is `repair` with `rehydration_lane=quant_metrics_rebuild`.
- If empirical jobs are stale, the lane is `repair` with `rehydration_lane=empirical_replay`.
- If `execution_order_events` is empty, paper/live lanes are blocked by `broker_event_reconcile_missing`.
- If options feature tables are empty, options hypotheses are `repair` with `rehydration_lane=options_feature_bootstrap`.
- If universe requires non-empty symbols and returns zero, paper/live lanes are blocked by `universe_rebind_required`.
- Only a hypothesis with current account metrics, fresh empirical jobs, broker-event watermark, and non-negative
  expected net edge after costs can become `paper_candidate`.

### Options Bootstrap Lane

The options lane starts as a data-readiness program, not a capital program.

Minimum first milestone:

- `options_contract_bars_1s` has rows for at least the selected liquid contract universe.
- `options_contract_features` has rows with non-null spread and quote-quality fields.
- `options_surface_features` has rows for the underlying universe.
- Options TA Flink job remains running with no failed tasks.
- The liquidity book marks options hypotheses `repair` or `paper_candidate` only after data watermarks are current.

Measurable hypothesis:

- `OPTIONS-BOOT-01`: a top-20 liquid contract universe produces non-empty bars, contract features, and surface features
  for two consecutive market sessions, then shows expected net edge at least 15 bps above estimated transaction cost in
  paper replay before any live consideration.

### Broker Event Reconciliation

`execution_order_events` is empty today. That makes any live capital claim incomplete, even with TCA metrics.

Minimum first milestone:

- Every broker submit, reject, fill, cancel, and replace writes an order event with account, strategy/hypothesis,
  client order id, broker order id when available, event timestamp, and source offset or idempotency key.
- TCA metrics cite broker event watermarks.
- The liquidity book reports `broker_event_watermark` and blocks paper/live when it is missing or stale.

Measurable hypothesis:

- `BROKER-RECON-01`: broker-event coverage reaches 100 percent for paper submissions and rejects across one full market
  session; no TCA metric used for promotion lacks a broker event ref.

### Account-Scoped Proof

Account identity must be explicit.

- Live account `PA3SX7FYNUTF` cannot consume generic Jangar metrics.
- Simulation account `TORGHUT_SIM` cannot satisfy live account proof.
- Paper account proof can inform paper promotion only for the same account/window.
- Generic metrics remain observe-only and repair triage.

Measurable hypothesis:

- `ACCOUNT-PROOF-01`: the scheduler and broker adapter reject every paper/live admission whose Jangar proof-liquidity
  record account does not match the Torghut hypothesis account.

## Implementation Scope

Engineer stage should land this in five slices:

1. Add a pure `HypothesisLiquidityBook` reducer under `services/torghut/app/trading/` that consumes existing readyz,
   empirical jobs, quant evidence, hypothesis summary, order-feed watermarks, and options data watermarks.
2. Add additive persistence or a compact materialized view for the current liquidity book.
3. Add route output to `/trading/status` and `/readyz` showing liquidity lanes, proof state, Jangar proof refs, and
   blocking reason codes.
4. Wire broker-event watermarks from `execution_order_events` into the reducer.
5. Add options data watermarks from ClickHouse tables and keep options capital blocked until all three options feature
   surfaces are non-empty and fresh.

## Validation Gates

- Unit tests cover the current state: live blocked by `simple_submit_disabled`, stale empirical jobs, stale
  live-account quant metrics, empty options feature tables, and empty broker events.
- API tests prove `/trading/status` exposes liquidity lanes and account-scoped proof refs without hiding the existing
  live submission gate.
- Broker tests prove paper/live submission rejects missing, stale, or account-mismatched proof-liquidity refs.
- Data tests prove options hypotheses remain repair-only while ClickHouse options feature tables are empty.
- Jangar integration tests prove generic proof-liquidity records cannot authorize Torghut capital.
- Regression tests prove rollback preserves liquidity and broker-event rows for audit.

## Rollout

1. Ship the reducer in shadow mode and compare the liquidity book with current `/readyz` and `/trading/status`.
2. Enable observe/repair lane publication to Jangar.
3. Require liquidity book rows for paper promotion while live remains disabled.
4. Enable options bootstrap data collection and hold all options capital until data watermarks are fresh for two
   sessions.
5. Enable broker-event reconciliation as a hard paper/live gate.
6. Only after account proof, empirical replay, options/equity data, and broker events are fresh should a deployer
   consider turning on a scoped paper candidate. Live requires a separate explicit approval and live submission change.

## Rollback

- Disable broker and scheduler consumption of liquidity-book decisions while continuing to write rows.
- Keep live submission disabled.
- Keep generic Jangar proof observe-only.
- If options bootstrap produces bad data, mark options lanes `blocked` and preserve raw rows for audit.
- Do not delete liquidity-book, proof, or broker-event rows during rollback.

## Risks

- The first reducer may over-hold capital. That is acceptable while live is disabled and paper lanes are in shadow.
- Account normalization mistakes can cause false missing-proof states; tests must lock live, simulation, paper, and
  generic account semantics.
- Options bootstrap may reveal no executable edge. That is still valuable: it prevents capital from chasing empty
  tables.
- `autonomy/lane.py` and `main.py` are large modules. Engineer work should add pure reducers and narrow route wiring
  instead of expanding those files further.

## Handoff

Engineer acceptance gate: Torghut emits an account-scoped hypothesis liquidity book; current live state maps to repair
or blocked lanes with explicit reasons; options hypotheses stay repair-only while options ClickHouse feature tables are
empty; broker-event reconciliation is a hard gate; and tests cover account mismatch, stale proof, empty options data,
and empty broker events.

Deployer acceptance gate: current live account `PA3SX7FYNUTF` remains no-go for paper/live capital until the liquidity
book cites fresh account-scoped Jangar proof, fresh empirical replay, non-empty data watermarks for the selected lane,
and broker-event reconciliation. Simulation may remain HTTP 200 for non-live mode, but it cannot satisfy live capital.
