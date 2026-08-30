# 178. Torghut Route Sample Mint And Capital Proof Ratchet (2026-05-08)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting a **route sample mint with a capital proof ratchet** for Torghut.

The current data says Torghut should not trade live notional, but it also says exactly how to improve. On 2026-05-08
at 02:11Z, Torghut `/readyz` returned `status=degraded` while Postgres, ClickHouse, Alpaca, universe, database schema,
and empirical jobs were healthy. The degradation was capital-specific: live submission was blocked by
`simple_submit_disabled`, the proof floor was `repair_only`, capital state was `zero_notional`, and zero hypotheses
were promotion-eligible. The proof floor named three blocking reasons: `hypothesis_not_promotion_eligible`,
`execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.

The profitability evidence is specific enough to be actionable. `/trading/tca` reported 7,334 orders and 7,245 filled
executions, with average absolute slippage around 13.82 bps. AAPL had 2,033 orders and 9.25 bps average absolute
slippage; AMD, AVGO, INTC, and NVDA were above the current route guardrail; AMZN, GOOGL, and ORCL had no route samples.
Empirical jobs were fresh for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
`janus_hgrm_reward`, but the forecast service was degraded with `registry_empty`, Lean authority was disabled, and
quant ingestion was only informational because pipeline-stage proof was missing.

The decision is to make Torghut mint route samples before it asks for capital. The route sample mint will create
zero-notional or paper-safe sample packets for symbols that are missing or above the slippage guardrail. Each packet
names the hypothesis, route, market-context receipt, quant-stage receipt, TCA target, sample budget, and rollback
trigger. A separate capital proof ratchet converts sample quality into notional only in steps: observe, zero-notional
repair, paper probe, live micro, and live scale. Jangar's source-settled capital ledger is required for every ratchet
step above zero-notional repair.

The tradeoff is slower paper admission for symbols with no samples. I accept that. The profitable architecture is not
"pick the best backtest and submit"; it is "buy the cheapest reliable evidence that can unlock the next capital class,
then stop immediately when the evidence says the route is too expensive."

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Runtime Evidence

- Argo CD reported `torghut` `Synced` and `Healthy` at `05900d8f39643c92457e22b97e909ee25521325d`.
- Torghut live `torghut-00292` and sim `torghut-sim-00391` pods were running. Rollout events showed initial startup
  and readiness probe failures followed by `RevisionReady`.
- Torghut pods for ClickHouse, keeper, CNPG, options catalog/enricher, TA, TA sim, and websocket services were running.
- The namespace still retained an errored `torghut-whitepaper-autoresearch-profit-target` pod from 13 hours earlier,
  and Agents retained intermittent market-context job failures. Current market-context and quant cron jobs were also
  completing, so this is retained debt plus intermittent data-provider fragility rather than a full outage.
- Direct database reads through CNPG and ClickHouse pod exec were blocked by RBAC, so database assessment used Torghut
  application projections.

### Data And Profit Evidence

- `/db-check` returned `ok=true`, expected Alembic head `0029_whitepaper_embedding_dimension_4096`,
  `schema_graph_lineage_ready=true`, `schema_graph_branch_count=1`, and parent-fork warnings for known historical
  migration branches.
- `/readyz` returned database `ok=true`, Postgres `ok=true`, ClickHouse `ok=true`, empirical jobs `healthy`, universe
  `ok` with 8 symbols from Jangar cache, and quant evidence `ok=true` but informational with
  `quant_pipeline_stages_missing`.
- `/trading/status` reported three hypotheses: one blocked, two shadow, zero promotion-eligible, and two requiring
  rollback. Reasons included `slippage_budget_exceeded`, `drift_checks_missing`, `feature_rows_missing`, and
  `required_feature_set_unavailable`.
- `/trading/tca` reported 7,334 orders, 7,245 filled executions, average absolute slippage around 13.82 bps, and
  latest execution created at `2026-04-02T19:00:29.586040Z` while TCA was recomputed on
  `2026-05-07T14:23:43.480686Z`.
- Route sample coverage is uneven: AAPL has enough data to probe; AMD, AVGO, INTC, and NVDA have high-cost samples;
  AMZN, GOOGL, and ORCL have no samples.
- Empirical jobs are fresh and truthful, but they are not sufficient for capital because route and alpha readiness
  remain blocked.

### Source Evidence

- `services/torghut/app/main.py` is the runtime join point for proof floor, route reacquisition, TCA, empirical jobs,
  forecast service, Lean authority, quant evidence, and alpha readiness. It is over 4,200 lines, so new promotion logic
  should be isolated in a pure module instead of adding more route-local policy to the FastAPI file.
- `services/torghut/app/trading/proof_floor.py` already fails closed for disabled live submission, failed alpha
  readiness, route universe gaps, and quant/TCA blockers.
- `services/torghut/app/trading/route_reacquisition.py` already models missing, blocked, and probing route states.
- `services/torghut/app/trading/hypotheses.py` and tests cover hypothesis readiness. The current source has 129
  trading modules and 146 Torghut test files, including property and stateful suites, so the right next move is a small
  pure reducer with focused tests.

## Problem

Torghut has a proof floor that blocks unsafe capital, but the system still needs a profitability engine for the next
safe repair. Right now the data surfaces can tell us that capital is blocked and why. They do not yet create the
minimum sample packet that would close a specific blocker at the lowest risk.

The concrete gaps are:

1. Missing route samples for AMZN, GOOGL, and ORCL are treated as blockers, but not as sample-mint work with budgets.
2. High-cost route samples for AMD, AVGO, INTC, and NVDA are blocked, but not assigned a target slippage improvement
   and stop-loss for evidence collection.
3. AAPL is probing, but it still needs market-context, quant-stage, and alpha receipts before paper notional.
4. Fresh empirical jobs can coexist with no promotion-eligible hypotheses.
5. Live TCA recency and latest execution recency diverge; recomputed metrics do not mean new route evidence was
   minted.

The profitable system has to decide which evidence sample to buy next and how that sample changes capital authority.

## Alternatives Considered

### Option A: Promote The Least Bad Existing Route

Use AAPL as the paper canary because it has the best route evidence among scoped symbols.

Advantages:

- Fastest path to paper observations.
- Uses an existing route sample base.
- Simple operator story.

Disadvantages:

- AAPL is still above the strict 8 bps guardrail in the current TCA summary.
- Alpha readiness has zero promotion-eligible hypotheses.
- Jangar source-settled capital authority is not yet a carried input.

Decision: reject for immediate capital. AAPL can be the first sample-mint target, not an automatic paper canary.

### Option B: Refresh All Route And Feature Evidence

Run broad zero-notional repair for all scoped symbols and all hypotheses.

Advantages:

- Maximizes evidence coverage.
- Clears many stale or missing facts in one campaign.
- Easy to schedule as a batch.

Disadvantages:

- Expensive and noisy.
- Does not prioritize by expected capital unlock.
- Risks hiding provider or route-specific failures inside aggregate success.

Decision: reject as the default. Broad refresh is only acceptable after the sample mint proves provider capacity and
per-symbol budgets.

### Option C: Route Sample Mint And Capital Proof Ratchet

Create budgeted sample packets for missing or high-cost symbols, then ratchet capital only when route quality,
hypothesis readiness, quant proof, market context, and Jangar source-settled authority converge.

Advantages:

- Turns blockers into measurable evidence purchases.
- Keeps capital at zero while still increasing future option value.
- Makes route quality and alpha readiness improve in small, falsifiable steps.
- Gives deployer and engineer a concrete acceptance gate for each capital class.

Disadvantages:

- Slower than direct paper promotion.
- Requires a new reducer and payload shape.
- Needs clear sample budgets to avoid collecting evidence that cannot unlock capital.

Decision: select Option C.

## Architecture

Add a `route_sample_mint` pure reducer that consumes route reacquisition, proof floor, TCA summary, hypothesis
readiness, empirical job status, quant evidence, market context, and the Jangar source-settled capital ledger.

```text
route_sample_packet
  packet_id
  symbol
  account_label
  hypothesis_ids
  current_route_state          # missing | blocked | probing | routeable
  sample_class                 # zero_notional | paper_probe | live_micro_probe
  jangar_ledger_ref
  proof_floor_ref
  market_context_ref
  quant_stage_ref
  tca_baseline_ref
  sample_budget
  target_sample_count
  target_avg_abs_slippage_bps
  max_expected_shortfall_bps
  expected_unlock
  stop_conditions
  rollback_target
```

The capital proof ratchet is separate from the mint:

```text
capital_proof_ratchet
  observe                 # dependencies readable; no capital
  zero_notional_repair    # sample packet cannot submit capital
  paper_probe             # paper-safe notional, Jangar paper cell allowed
  live_micro              # capped live notional, paper settlement complete
  live_scale              # multiple live micro windows, no active rollback
```

Ratchet rules:

- `observe` is allowed while storage, universe, and application projections are healthy.
- `zero_notional_repair` requires a sample packet, route budget, and no capital submission path.
- `paper_probe` requires Jangar `paper_canary` ledger allowance, route sample count above threshold, average absolute
  slippage below 8 bps for the symbol, no alpha rollback requirement, current market-context receipt, and quant-stage
  proof not informational.
- `live_micro` requires paper settlement, live submit enabled, average absolute slippage below 12 bps, no missing
  scoped symbols for the selected lane, and Jangar `live_micro` allowance.
- `live_scale` requires multiple live micro windows, no proof-floor blocker, no stale quant stage, and Jangar
  `live_scale` allowance.

## Measurable Hypotheses

- H1: AAPL sample repair can reduce average absolute slippage from 9.25 bps to below 8 bps before any paper canary.
- H2: Missing-symbol minting for AMZN, GOOGL, and ORCL can produce at least 20 paper-safe TCA samples per symbol
  without average absolute slippage above 12 bps.
- H3: High-cost route repair for AMD, AVGO, INTC, and NVDA should not advance to paper until each symbol improves
  below 12 bps or is excluded from the active universe.
- H4: At least one hypothesis must move from shadow to paper-eligible with no rollback-required state before paper
  notional.
- H5: Quant pipeline-stage proof must move from informational to pass before live scale.

## Guardrails

- Capital notional remains `0` while proof floor is `repair_only`.
- A sample packet cannot request paper or live capital without a matching Jangar ledger action.
- Missing route samples produce zero-notional or paper-safe sample work, not live orders.
- If latest execution recency is stale while TCA recomputation is fresh, the packet must call that out as stale live
  execution evidence.
- Any reducer error fails closed to `observe` or `zero_notional_repair` with no notional.

## Implementation Scope

Engineer stage:

- Add `app/trading/route_sample_mint.py` as a pure reducer with typed packet and ratchet payloads.
- Feed it from existing proof-floor, route-reacquisition, TCA, hypothesis, quant, empirical, and market-context
  payloads.
- Add the reducer output to `/trading/status` and `/readyz` in shadow mode without changing live submission behavior.
- Add tests for the current evidence state: AAPL probing, four high-cost symbols, three missing symbols, zero
  promotion-eligible hypotheses, quant-stage informational, and Jangar ledger missing/held.
- Keep live submission disabled until the ratchet has a passing paper gate and operator approval.

Deployer stage:

- Verify the route sample mint route answers within the same route budget as the proof floor.
- Wire Jangar source-settled ledger refs into the Torghut status payload.
- Run a shadow day where sample packets are emitted but not acted on by capital submission.
- Approve only zero-notional repair until the paper ratchet gate passes.

## Validation Gates

Local validation:

- `uv run --frozen pytest tests/test_route_sample_mint.py tests/test_profitability_proof_floor.py tests/test_route_reacquisition.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- Existing trading readiness tests continue to fail closed when sample or ledger evidence is missing.

Live validation:

- `/db-check` remains `ok=true` and schema lineage ready.
- `/trading/status` exposes `route_sample_mint.mode=shadow`.
- Sample packets exist for AMZN, GOOGL, and ORCL as missing-symbol work with zero live notional.
- AAPL cannot advance beyond sample repair until slippage is below 8 bps and alpha readiness has a paper-eligible
  hypothesis.
- Paper and live gates cite a Jangar source-settled capital ledger ref.

## Rollout And Rollback

Rollout starts with shadow status only. Then zero-notional sample packets can drive repair scheduling. Paper probes
come later and require explicit deployer approval plus Jangar paper authority. Live micro and live scale are separate
ratchet steps.

Rollback disables route sample mint consumption and leaves the existing proof floor in control. Rollback must not
enable simple submit or change notional caps. If the mint emits bad packets, ignore them, keep capital at zero, and
repair the reducer with regression tests.

## Risks

- The sample mint can over-prioritize symbols with many historical rows unless latest execution recency is weighted.
- Market-closed observations can look stale; the reducer must distinguish expected closed-session staleness from
  actionable provider failure.
- If Jangar ledger refs are missing too often, Torghut will make useful repair suggestions that cannot advance to
  paper. That is acceptable until source-settled authority is wired.

## Handoff

Engineer: build the route sample mint as a pure reducer and prove it emits the current state correctly: AAPL probing,
AMD/AVGO/INTC/NVDA high-cost blocked, AMZN/GOOGL/ORCL missing, no promotion-eligible hypotheses, quant-stage
informational, and zero notional.

Deployer: keep capital locked, wire Jangar ledger refs, run one shadow day, then allow only zero-notional repair until
the paper ratchet has fresh route samples, alpha readiness, quant-stage proof, and source-settled Jangar paper
authority.
