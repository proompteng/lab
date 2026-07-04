# 174. Torghut Route-Local Profit Lab And Capital Frontier (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut route-local profitability research, execution-cost settlement, quant evidence repair, promotion
custody, capital frontier admission, rollout, rollback, and Jangar handoff.

Companion Jangar contract:

- `docs/agents/designs/170-jangar-profit-witness-broker-and-source-truth-capital-custody-2026-05-08.md`

Extends:

- `173-torghut-no-notional-repair-options-desk-and-promotion-custody-2026-05-07.md`
- `172-torghut-repair-yield-ledger-and-session-proof-capital-gates-2026-05-07.md`
- `171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md`
- `docs/agents/designs/170-jangar-profit-witness-broker-and-source-truth-capital-custody-2026-05-08.md`

## Decision

I am selecting a **route-local profit lab with a capital frontier** as the next Torghut quant architecture step.

Torghut is operational, but it is not capital-ready. Live `/trading/health` is degraded for the right reasons:
Postgres, ClickHouse, Alpaca, universe freshness, empirical jobs, and DSPy fallback are healthy enough for observation,
but the live submission gate is closed, proof floor is `repair_only`, capital state is `zero_notional`, alpha
readiness has zero promotion-eligible hypotheses, route TCA fails or is missing for most of the universe, and the
account/window quant ingestion stage is stale by `552911` seconds. Sim is healthier as an execution environment, but
its route evidence is emptier: account `TORGHUT_SIM` has zero latest quant metrics, seven missing route-TCA symbols,
and one blocked `NVDA` route with average absolute slippage around `110` bps.

The profitable move is not to ask for capital. It is to build a route-local lab that turns each symbol and hypothesis
into a measurable no-notional experiment, settles execution cost separately from alpha quality, and only advances a
capital frontier when the evidence is fresh enough for Jangar to broker. The current global proof floor is doing its
job by blocking capital. The next leverage point is to stop treating an eight-symbol universe as one gate.

The tradeoff is slower headline promotion. I am choosing that because paper/live capital without route-local economics
would only measure slippage leakage faster. Torghut should spend the next cycle manufacturing promotion-quality
receipts for the few routes that can plausibly carry post-cost edge.

## Current Evidence

All evidence in this pass was collected read-only on 2026-05-08. I did not mutate Kubernetes resources, database
records, secrets, GitOps manifests, promotion records, or trading flags.

### Runtime And Cluster Evidence

- `torghut` namespace showed live revision `torghut-00291-deployment` and sim revision
  `torghut-sim-00390-deployment` running on the same promoted digest.
- ClickHouse, Keeper, Torghut DB, TA, TA sim, options catalog, options enricher, WebSocket services, and guardrail
  exporters were running.
- `torghut-whitepaper-autoresearch-profit-target-8r6w6` remained in `Error`.
- Recent events showed migration jobs completing during rollout, startup/readiness probes failing briefly during
  revision transitions, ClickHouse duplicate PDB warnings, and `torghut-options-ta` FlinkDeployment status churn from
  external modifications.
- Knative CRDs were not readable by this service account, so live/sim revision evidence came from standard
  deployments, pods, services, events, and service endpoints.

### Trading Evidence

- Live `/healthz` returned `status=ok`.
- Live `/db-check` returned schema current at Alembic head `0029_whitepaper_embedding_dimension_4096` with lineage
  ready and historical migration fork warnings.
- Live `/trading/health` returned `status=degraded`.
- Live proof floor:
  - `floor_state=repair_only`;
  - `route_state=repair_only`;
  - `capital_state=zero_notional`;
  - `max_notional=0`;
  - blockers `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
    `simple_submit_disabled`.
- Live route/TCA:
  - scope symbols: `AAPL`, `AMD`, `AMZN`, `AVGO`, `GOOGL`, `INTC`, `NVDA`, `ORCL`;
  - 7,334 orders and 7,245 filled executions in the live TCA payload;
  - average absolute slippage around `13.82` bps against an 8 bps guardrail;
  - `AAPL` is probing but still blocked by dependency receipts;
  - `AMD`, `AVGO`, `INTC`, and `NVDA` are blocked by route TCA;
  - `AMZN`, `GOOGL`, and `ORCL` are missing route evidence.
- Live quant evidence for account `PA3SX7FYNUTF`:
  - latest metrics count `144`;
  - latest metrics updated around `2026-05-08T00:11:07Z`;
  - compute and materialization stages were fresh;
  - ingestion stage lag was `552911` seconds, making the account/window pipeline degraded.
- Live hypotheses:
  - 3 total;
  - 1 blocked, 2 shadow;
  - 0 promotion eligible;
  - 2 rollback required;
  - blockers include slippage budget exceeded, feature rows missing, drift checks missing, and unavailable feature
    sets.
- Empirical jobs are fresh and promotion-authority eligible for `chip-paper-microbar-composite@execution-proof`, but
  forecast authority is degraded with `registry_empty`, Lean authority is disabled, and no live promotion can consume
  those jobs yet.

### Sim Evidence

- Sim `/db-check` returned schema current at the same Alembic head.
- Sim `/trading/health` returned `status=ok` for runtime dependencies, but proof floor remained `repair_only` and
  capital remained `zero_notional`.
- Sim route/TCA had only 5 filled executions, all on `NVDA`, with average absolute slippage around `110` bps.
- Sim route universe had 0 routeable symbols, 1 blocked symbol, and 7 missing symbols.
- Sim quant latest metrics were empty for `TORGHUT_SIM`; Jangar quant health returned `quant_latest_metrics_empty` and
  `quant_pipeline_stages_missing`.

### Source Evidence

- `services/torghut/app/main.py` assembles health, status, proof floor, route reacquisition, quant evidence, and
  promotion-related payloads from multiple surfaces.
- `services/torghut/app/trading/proof_floor.py` is 718 lines and is the current capital gate.
- `services/torghut/app/trading/route_reacquisition_board.py` is 286 lines and turns proof-floor route evidence into a
  ranked repair board.
- `services/torghut/app/trading/submission_council.py` is 1,202 lines and owns submission gate, quant evidence,
  promotion certificate, and capital-stage logic.
- `services/torghut/app/trading/hypotheses.py` is 791 lines and owns runtime hypothesis state.
- `services/torghut/app/trading/tca.py` is 972 lines and includes the note that code-level TCA fixes do not affect
  promotion evidence until stale rows are rematerialized.
- The Torghut test surface is broad: 156 test files, including tests for proof floor, route reacquisition, TCA refresh,
  empirical jobs, promotion truthfulness, hypotheses, and forecast service.
- The gap is not absence of tests. The gap is that route-local experiments, quant-ingestion repair, TCA settlement,
  and promotion custody are still separate outputs rather than one capital-frontier ledger.

### Database And Data Evidence

- Direct database reads were blocked by RBAC in this run; CNPG CRD reads, pod exec, and secret listing were forbidden.
- Service-owned data witnesses were available and are the right least-privilege evidence source for this lane.
- Live and sim `/db-check` both confirmed the schema head and migration lineage were current.
- The schema graph still reports historical parent forks at revisions `0010` and `0015`; lineage is ready, but the
  warnings should remain visible in capital-frontier receipts.
- Account-scope checks are bypassed while multi-account trading is disabled, which is acceptable for the current live
  account but must not become a hidden blocker when capital scope expands.

## Problem

Torghut has useful proof, but it is not arranged in the shape capital needs.

Global readiness says the service can run. Proof floor says capital must stay closed. Route reacquisition says where
the repair candidates are. Empirical jobs say one candidate has useful research evidence. Hypothesis readiness says no
hypothesis is promotion eligible. Quant health says global metrics can be fresh while the account/window ingestion
stage is badly stale.

That combination is too nuanced for one gate. The system needs route-local capital frontiers:

1. A route can have enough execution history but fail slippage.
2. A route can be promising but lack dependency receipts.
3. A symbol can be missing all route evidence.
4. A hypothesis can be blocked by features or drift even when empirical jobs are fresh.
5. A quant pipeline can be fresh globally and stale for the account/window that capital would use.

Profitability improves when those cases are separated, measured, and closed in the cheapest order.

## Alternatives Considered

### Option A: Keep The Existing Proof Floor And Route Board

Continue using proof floor plus route reacquisition board as the main repair plan.

Advantages:

- Already implemented.
- Correctly blocks capital.
- Produces a useful ranked list.

Disadvantages:

- Still treats the universe as one capital gate.
- Does not settle account/window quant ingestion as a first-class route blocker.
- Does not require every repair to produce a promotion receipt.
- Does not isolate execution-cost repair from alpha-quality repair.

Decision: keep as input, reject as the next architecture boundary.

### Option B: Global Evidence Refresh Before Any Promotion Work

Refresh market context, quant ingestion, route TCA, feature rows, drift checks, forecast registry, and promotion tables
before running route-local experiments.

Advantages:

- Improves broad data quality.
- Easy to reason about.
- Reduces stale proof.

Disadvantages:

- Wastes compute on surfaces that may not unlock the next profitable route.
- Can leave paper/live blocked with no new promotion-quality receipt.
- Does not price repair by expected capital-frontier movement.

Decision: reject as too blunt.

### Option C: Route-Local Profit Lab With Capital Frontier

Create a per-route, per-hypothesis lab that runs no-notional experiments, writes route-local settlement receipts, and
advances a capital frontier only when Jangar broker custody allows the next action class.

Advantages:

- Converts repair work into measurable trading hypotheses.
- Separates execution cost, quant freshness, market context, feature/drift, and promotion custody.
- Lets Torghut prioritize symbols by expected unblock value and cost.
- Keeps all current work no-notional until evidence earns paper.

Disadvantages:

- Adds a new ledger and frontier model.
- Requires calibration of cost and expected value estimates.
- Delays paper canary until route-local receipts close.

Decision: select Option C.

## Architecture

Torghut emits:

```text
route_local_profit_lab
  schema_version
  lab_id
  generated_at
  account_label
  revision
  jangar_profit_witness_broker_ref
  route_experiments
  capital_frontier
  promotion_receipts
  rollback_target
  fresh_until
```

Each `route_experiment` has:

```text
experiment_id
symbol
hypothesis_ids
experiment_class       # route_tca_repair | quant_ingestion_repair | feature_drift_repair | promotion_receipt
starting_state         # probing | blocked | missing
expected_unblock_value
estimated_compute_cost
max_notional
required_inputs
required_outputs
metric_targets
promotion_custodian
expires_at
```

The `capital_frontier` is not a trading signal. It is a custody ledger:

```text
capital_frontier
  frontier_id
  account_label
  state                 # observe | no_notional_lab | paper_candidate | paper_canary | live_candidate
  eligible_symbols
  blocked_symbols
  evidence_debts
  jangar_action_packet_ref
  max_notional
  rollback_target
```

Initial state for this evidence snapshot:

- `state=no_notional_lab`;
- `max_notional=0`;
- `eligible_symbols=[]`;
- `blocked_symbols=[AAPL, AMD, AMZN, AVGO, GOOGL, INTC, NVDA, ORCL]`;
- `paper_candidate` is unavailable until at least one route closes TCA, quant, alpha-readiness, and promotion custody
  receipts.

## Trading Hypotheses

The lab should start with these measurable hypotheses:

- `H-ROUTE-AAPL-01`: AAPL can become the first paper candidate if dependency receipts close and route-local slippage
  is brought under 12 bps average absolute slippage with at least 40 paper or replay fills.
- `H-ROUTE-NVDA-01`: NVDA is high-value because it has the largest live filled-execution count, but it must reduce
  average absolute slippage below 12 bps and prove no more than 20 bps p95 realized shortfall before any paper probe.
- `H-MISSING-ROUTE-01`: AMZN, GOOGL, and ORCL should receive simulation probes before any live/paper consideration;
  success requires at least 20 clean replay fills per symbol, no missing TCA rows, and quant/account window lag below
  300 seconds.
- `H-INGESTION-01`: Account/window quant ingestion lag above 900 seconds should veto route promotion even when global
  metrics are fresh; promotion requires ingestion, compute, and materialization stages all below 300 seconds for two
  consecutive samples.
- `H-ALPHA-READINESS-01`: A route-local paper candidate cannot form until at least one linked hypothesis is promotion
  eligible and not rollback-required.

## Guardrails

- All route experiments start with `max_notional=0`.
- Paper canary requires:
  - Jangar `paper_canary` custody packet is `allow`;
  - Torghut proof floor is no longer `repair_only`;
  - account/window quant ingestion lag is below 300 seconds;
  - route TCA has no missing symbols for the candidate route;
  - average absolute slippage is below the route threshold;
  - at least one linked hypothesis is promotion eligible;
  - promotion receipt is persisted or explicitly denied with evidence.
- Live micro canary requires paper evidence, live submission enabled, and Jangar live packet `allow`.
- Any expired route experiment falls back to `blocked` with `max_notional=0`.

## Implementation Scope

Engineer stage:

- Add `route_local_profit_lab` to `/trading/status` and `/trading/health` in advisory mode.
- Build it from existing proof-floor, route reacquisition, TCA, quant evidence, hypothesis, and empirical-job
  functions before adding persistence.
- Add tests proving:
  - all current experiments start at zero notional;
  - account/window quant ingestion lag blocks paper;
  - missing route TCA produces simulation-probe experiments;
  - high slippage produces route-repair experiments;
  - no promotion-eligible hypothesis blocks the frontier;
  - Jangar broker holds prevent paper/live frontier movement.
- Keep existing proof floor as the hard capital gate.

Deployer stage:

- Roll advisory payload behind a feature flag.
- Compare the lab frontier with proof-floor and route-board state during one market-open and one market-closed window.
- Do not enable paper canary unless both proof floor and Jangar broker allow it.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/torghut/design-system/v6/174-torghut-route-local-profit-lab-and-capital-frontier-2026-05-08.md`
- Torghut targeted tests once implemented:
  `uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_route_reacquisition.py tests/test_hypotheses.py tests/test_refresh_execution_tca_metrics_script.py`
- Type checks for Torghut code changes:
  `uv run --frozen pyright --project pyrightconfig.json`
  `uv run --frozen pyright --project pyrightconfig.alpha.json`
  `uv run --frozen pyright --project pyrightconfig.scripts.json`

Cluster validation:

- `curl /healthz`
- `curl /db-check`
- `curl /trading/health`
- `curl /trading/status`
- `curl /api/torghut/trading/control-plane/quant/health?account=<account>&window=15m`
- Confirm live capital remains zero-notional until the frontier has a paper candidate and Jangar broker custody allows
  paper.

## Rollout

1. Ship the advisory route-local lab payload.
2. Generate frontier state from current proof floor and route board without changing trading flags.
3. Run one market-open and one market-closed shadow comparison.
4. Persist frontier receipts only after the derived payload matches current proof-floor decisions.
5. Allow paper candidate formation only after Jangar broker packets are available.
6. Keep live submission disabled until paper custody proves route-local edge after cost.

## Rollback

- Disable the advisory payload and continue using proof floor plus route reacquisition board.
- Retire any frontier receipt whose source evidence expires.
- Reset all frontier states to `no_notional_lab` if Jangar broker packets are missing, stale, or contradictory.
- Keep live submission disabled and max notional zero whenever route, quant, hypothesis, or promotion custody is
  unknown.

## Risks

- False precision: expected unblock value can look more scientific than it is. Mitigation: label it as ranking input,
  not PnL forecast, until calibrated.
- Payload complexity: `/trading/status` is already large. Mitigation: return compact frontier rows and link detailed
  evidence refs.
- Market closed bias: current evidence includes expected closed-session staleness. Mitigation: require one
  market-open validation window before paper candidate promotion.
- RBAC blind spots: direct DB inspection is unavailable. Mitigation: use `/db-check`, proof-floor receipts, and Jangar
  database witnesses as the audit contract.

## Handoff Contract

Engineer acceptance gates:

- Advisory `route_local_profit_lab` is emitted on live and sim status surfaces.
- The current evidence snapshot derives `state=no_notional_lab`, `max_notional=0`, and no paper candidates.
- Tests cover route missingness, high slippage, quant ingestion lag, no promotion-eligible hypotheses, and Jangar
  broker holds.
- The implementation does not enable paper/live submission.

Deployer acceptance gates:

- Live and sim payloads are visible after rollout.
- Live proof floor remains `repair_only` until route-local receipts close.
- Sim missing-route evidence creates simulation-probe work, not paper/live capital.
- Rollback is feature-flag disable plus zero-notional fallback.
