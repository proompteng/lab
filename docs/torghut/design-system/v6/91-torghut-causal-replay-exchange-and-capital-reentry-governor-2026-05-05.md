# 91. Torghut Causal Replay Exchange and Capital Reentry Governor (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: historical simulation, replay, Lean backtest APIs, and local replay scripts exist, but older monolithic simulation assumptions have been split.
- Matched implementation area: Simulation, replay, backtesting, and Lean.
- Current source evidence:
  - `services/torghut/scripts/run_local_simple_lane_replay.py`
  - `services/torghut/scripts/verify_historical_simulation_parity.py`
  - `services/torghut/app/api/trading_misc/lean_backtests.py`
  - `services/jangar/src/routes/api/torghut/simulation/runs.ts`
  - `argocd/applications/torghut/historical-simulation-workflowtemplate.yaml`
- Design drift note: Simulation docs must be checked against current split scripts and Jangar simulation routes.


## Decision

Torghut should move from passive proof collection to a **CausalReplayExchange** and a **CapitalReentryGovernor**. The
system has enough strategy candidates and enough guardrails. What it lacks is a disciplined way to buy the next unit of
evidence, falsify weak hypotheses quickly, and re-enter capital only when the proof is current, causal, and executable.

The decision is to treat each trading idea as a capital claim with an information budget:

- zero-notional replay answers whether the hypothesis still has edge after current costs and route state;
- paper capital answers whether the edge survives broker semantics and live data delay;
- live capital answers whether the paper result is stable enough for constrained notional;
- stale proof creates debt, not permission.

I am choosing this because the live service is behaving correctly at the safety layer but not yet learning aggressively
enough at the profitability layer. Live Torghut is up, schema-current, and broker-connected. It also has zero
promotion-eligible hypotheses, three rollback-required hypotheses, blocked empirical quorum, and Jangar quant-health
timeouts. That means the right next architecture is not "turn trading back on." It is a capital reentry governor that
funds causal proof work while keeping broker exposure closed.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Route Evidence

- Live Torghut revision `torghut-00221` returned HTTP 200 for `/healthz` and `/trading/status`.
- Live `/readyz` returned HTTP 503. The payload showed Postgres, ClickHouse, Alpaca, database schema, and universe OK,
  but live submission gate failed with `simple_submit_disabled` and capital stage `shadow`.
- Live `/trading/health` returned HTTP 503 for the same reason.
- Sim Torghut revision `torghut-sim-00302` returned HTTP 200 for `/readyz` and `/trading/health`, but quant evidence
  was informationally failed because Jangar quant health timed out.
- Torghut pods were running, including Postgres, ClickHouse, Keeper, TA workers, options services, and websocket
  forwarders. Recent events still showed rollout probe churn, repeated DB migration/backfill hooks, ClickHouse
  multiple-PDB warnings, and readiness failures during new revisions.
- Jangar became unavailable during the pass after first serving status successfully. Its app logs showed Postgres
  connection-slot exhaustion and Kysely query read timeouts. That makes Jangar platform proof a capital dependency, not
  an optional dashboard field.

### Database and Data Evidence

- Direct CNPG SQL was blocked by `pods/exec` RBAC. The smallest unblocker is read-only CNPG exec or a read-only SQL
  proxy/export route.
- Torghut `/db-check` returned HTTP 200 with current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, no duplicate revisions, and no orphan
  parents.
- The schema graph still carries known parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Live status showed `last_decision_at=2026-05-04T17:25:57Z`, current loop activity, 12-symbol Jangar universe cache,
  signal lag inside threshold during the sample, and zero submitted simple-lane orders.
- The same status showed three hypotheses, all in shadow or blocked state, zero promotion-eligible hypotheses, and
  rollback required for all three.
- Empirical dependency quorum remained blocked on `empirical_jobs_degraded`.

### Source Evidence

- `services/torghut/app/trading/empirical_jobs.py::build_empirical_jobs_status` already evaluates freshness,
  truthfulness, dataset snapshots, candidate consistency, job status, and promotion authority.
- `services/torghut/app/trading/submission_council.py::build_live_submission_gate_payload` already composes
  dependency quorum, empirical jobs, quant health, promotion certificates, market-context references, and reason codes.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still bypasses the submission council in simple
  live mode and relies on local toggles. The current rollout sets those toggles to shadow, so capital is safe, but the
  architecture should remove this split before live reentry.
- Jangar quant health uses `torghut_control_plane.quant_metrics_latest` and `quant_pipeline_health`; the route can time
  out under DB pressure. Torghut should consume receipts from the Jangar backplane rather than compiling capital proof
  from that route at request time.

## Problem

Torghut is safe enough to avoid accidental live exposure, but safety alone does not increase profitability. The current
failure mode is stale or expensive proof:

1. empirical jobs are not fresh enough to clear dependency quorum;
2. quant-health reads can time out when Jangar is under DB pressure;
3. simple live mode has a local gate path that is separate from the proof-aware council;
4. route health and schema currency can be green while capital proof is absent;
5. paper/sim can look operationally healthy without proving causal lift over current costs.

The next system should decide which hypothesis deserves the next proof dollar, not just whether a route is up.

## Alternatives Considered

### Option A: Re-enable Paper/Live Through Existing Simple Lane

Keep the simple lane, rely on local toggles, and let empirical jobs catch up later.

Pros:

- Fastest way to generate broker-side observations.
- Low implementation cost.
- Existing kill switch and submit toggles can stop damage.

Cons:

- Does not prove causal edge.
- Can spend paper/live exposure on stale hypotheses.
- Ignores Jangar route pressure as a capital dependency.
- Leaves two live gate implementations in conflict.

Decision: reject. It creates activity before proof.

### Option B: Freeze All Capital Until Every Proof Route Is Green

Require Jangar status, quant health, empirical jobs, market context, TCA, options, and DB routes to be green before any
zero-notional, paper, or live work proceeds.

Pros:

- Conservative and easy to explain.
- Prevents live exposure during platform ambiguity.
- Keeps the broker path clean.

Cons:

- Starves the proof producers that would repair freshness.
- Treats zero-notional replay like broker exposure.
- Gives no ranking across hypotheses.
- Can miss high-value market regimes while waiting for unrelated proof.

Decision: keep as emergency posture only.

### Option C: CausalReplayExchange and CapitalReentryGovernor

Fund proof producers by expected information value, persist causal replay receipts, and let a governor advance from
zero-notional to paper to live only when fresh receipts and Jangar backplane authority agree.

Pros:

- Increases learning rate while capital stays closed.
- Makes profitability hypotheses measurable and falsifiable.
- Separates proof work from broker exposure.
- Uses Jangar platform pressure as a capital input.
- Gives deployers clear rollout and rollback gates.

Cons:

- Adds receipt and ranking logic.
- Requires careful experiment design to avoid overfitting.
- Initial live reentry will be slower than a toggle flip.

Decision: select Option C.

## Chosen Architecture

### HypothesisExperiment

Each candidate strategy family gets a current experiment contract.

```text
hypothesis_experiment
  experiment_id
  hypothesis_id
  strategy_family              # opening_drive, vwap_reversion, weak_open_short, tsmom, options_event
  account_scope
  symbol_universe_ref
  market_regime_scope
  max_notional_stage           # zero_notional, paper, live_probe, live_scaled
  expected_information_value
  falsification_condition
  required_receipt_types       # replay, empirical, tca, route, market_context, jangar_backplane
  observed_at
  fresh_until
```

The initial exchange should rank existing Torghut families already represented in source/config:

- opening-drive continuation on the current 12-symbol Jangar universe;
- VWAP stretch reversion for high-liquidity names;
- weak-open short and late-day continuation with explicit borrow/shorting metadata;
- options event lane only when options catalog and OPRA-derived evidence are ready;
- TSMOM only as a benchmark, not the default capital sink.

### CausalReplayExchange

The exchange allocates zero-notional and paper proof slots.

Rules:

- Prefer experiments with high expected information value and low current proof debt.
- Require an explicit counterfactual baseline: no-trade, TSMOM benchmark, and current simple-lane behavior.
- Reject receipts that do not include dataset snapshot, cost model, slippage budget, and market-regime scope.
- Mark stale receipts as debt; do not let them clear capital.
- Keep zero-notional replay open under Jangar `repair` authority, but hold paper/live when the Jangar backplane holds
  capital.

### CapitalReentryGovernor

The governor advances capital stages only when receipts line up.

```text
capital_reentry_governor
  scope
  jangar_backplane_authority_id
  experiment_id
  replay_receipt_digest
  empirical_receipt_digest
  tca_receipt_digest
  market_context_receipt_digest
  decision                     # observe, replay, paper_probe, live_probe, live_scaled, hold, block
  max_notional
  reason_codes
  expires_at
```

Minimum gate:

- `replay`: fresh schema, dataset snapshot, route proof, and Jangar `repair` or better.
- `paper_probe`: replay receipt fresh, empirical quorum allow, quant-health receipt fresh, broker paper route OK, and
  Jangar `paper_submit` authority not held.
- `live_probe`: two consecutive market sessions of paper probe receipts, no critical rollback, current TCA budget, and
  Jangar `live_submit` authority allowed.
- `live_scaled`: live probe positive after costs, drawdown inside budget, and no unresolved platform fuse.

## Engineer Scope

1. Add a pure experiment ranking module that computes expected information value from freshness, cost, regime coverage,
   and falsification priority.
2. Add receipt references to `/trading/status`, `/trading/health`, and `/readyz` without adding deep request-time proof
   scans.
3. Route simple live mode through the proof-aware submission council before any live reentry is allowed.
4. Add Jangar backplane receipt consumption to the submission council and capital governor.
5. Add zero-notional replay receipts for the initial strategy families.
6. Add paper probe and live probe governors with max-notional, expiry, and reason-code outputs.
7. Keep order submission disabled until the governor emits paper/live decisions in shadow for two market sessions.

## Validation Gates

- Unit test: a stale Jangar backplane receipt holds `paper_probe` and `live_probe` while allowing `replay`.
- Unit test: simple live mode cannot bypass the proof-aware submission council.
- Unit test: zero promotion-eligible hypotheses produce `hold`, not `paper_probe`.
- Unit test: stale empirical jobs create proof debt and do not clear capital.
- Integration test: Jangar quant-health timeout appears as a receipt reason and blocks paper/live.
- Backtest validation: each initial hypothesis reports gross PnL, net PnL, turnover, slippage, drawdown, and
  counterfactual lift against no-trade and TSMOM.
- Deployer smoke: live `/trading/status` shows capital stage `shadow` until receipt digests and Jangar backplane
  authority are fresh.

## Rollout Plan

1. Ship experiment ranking and receipt projection with no capital enforcement change.
2. Produce zero-notional replay receipts for at least two market sessions.
3. Enable paper-probe governor in shadow and compare with current submit toggles.
4. Enforce paper-probe governor with low notional only after zero false paper allows in shadow.
5. Enable live-probe governor in shadow after paper receipts are stable.
6. Enforce live probe with explicit max notional and automatic rollback on stale receipts or Jangar backplane hold.

## Rollback Plan

- Set governor enforcement to `shadow`; keep receipt production.
- Disable individual experiment families by strategy family without disabling the whole exchange.
- If Jangar backplane consumption regresses, treat Jangar authority as `hold` and keep Torghut in zero-notional replay.
- If paper/live reentry creates broker or PnL regression, revert to `simple_submit_disabled` and preserve all negative
  receipts for analysis.

## Risks

- Expected information value can be gamed by noisy strategies; require counterfactual lift and falsification.
- Market-session sample sizes will be small at first; do not scale live from one good window.
- Options lanes must remain gated on options catalog/enricher readiness and OPRA data quality.
- The system needs a read-only SQL/export path for richer database assessment; app routes are not enough during DB
  incidents.

## Handoff

Engineer acceptance gate: Torghut can explain, from one status payload, why each hypothesis is replay-only, paper
eligible, live-probe eligible, or held, with receipt digests and reason codes.

Deployer acceptance gate: live capital remains closed until the governor cites fresh replay, empirical, quant-health,
TCA, market-context, and Jangar backplane receipts for the exact account, strategy family, and market window.
