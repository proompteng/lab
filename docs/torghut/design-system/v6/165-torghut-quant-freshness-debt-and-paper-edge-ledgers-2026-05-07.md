# 165. Torghut Quant Freshness Debt And Paper Edge Ledgers (2026-05-07)

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

I am selecting quant freshness debt and paper edge ledgers as the next Torghut profitability architecture step.

Torghut is still correctly zero-notional. Live health is degraded, live proof floor is repair-only, live routeability is
zero of eight symbols, live submission is disabled, market context is stale, and no hypotheses are promotion eligible.
Simulation is healthier operationally, but not promotable: it has one `NVDA` probing path, seven missing symbols, stale
TCA, stale market context, empty quant metrics, and no promotion-eligible hypotheses.

The current opportunity is to price repair work by expected edge recovery, not to trade. Live quant has useful signal
materialization evidence, but ingestion is stale. Simulation has no latest quant metrics at all. Route repair has a
candidate order, but paper rehearsal is not yet earned. Torghut needs a ledger that turns those blockers into
ranked, falsifiable, zero-notional work: settle quant ingestion lag, refill simulation metrics, repair market context,
and only then promote paper edge candidates.

The tradeoff is slower paper promotion. I accept that. A paper run with stale market context and missing quant receipts
would create evidence debt. A ledger that prices each repair by expected unblock value gives us a better path to
profitability because it identifies which blocker unlocks the next measurable experiment.

## Runtime Objective And Success Metrics

Success means:

- `/trading/status`, `/trading/health`, and `/trading/autonomy` expose `quant_freshness_debt_ledger`.
- Each ledger entry cites Jangar `stage_debt_clearinghouse` credit or terminal receipt when the repair depends on a
  Jangar stage.
- Live and simulation entries always keep `max_notional=0` while proof floor is `repair_only`.
- The ledger separates `live_quant_ingestion_debt`, `simulation_quant_empty_store`, `market_context_debt`,
  `route_tca_debt`, and `alpha_promotion_debt`.
- Paper edge candidates require fresh quant receipt, market-context receipt, TCA route receipt, alpha readiness receipt,
  and Jangar stage-debt credit closure.
- Live micro-canary remains blocked until paper edge ledger has at least two closed, zero-notional paper rehearsals
  with no unsettled executions and Jangar `paper_canary` no longer held.
- Deployer output ranks repairs by expected unblock value, blocker age, capital risk, and hypothesis coverage.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 from 19:00Z to 19:10Z. I did not mutate Kubernetes resources, database
records, ClickHouse data, broker state, GitOps resources, AgentRun objects, or trading flags.

### Runtime And Cluster Evidence

- Torghut live revision `torghut-00278-deployment` was `1/1`; simulation revision
  `torghut-sim-00378-deployment` was `1/1`.
- Older live/simulation Knative revisions were scaled to zero.
- Torghut app, options catalog, and options enricher were on the latest promoted Torghut digest
  `sha256:adee8018...`.
- Torghut TA, TA simulation, WebSocket services, options TA, ClickHouse, Keeper, and exporters were running.
- Recent Torghut events showed rollout startup/readiness probe noise, completed bootstrap/backfill jobs, and recurring
  ClickHouse PDB match warnings.
- `torghut-whitepaper-autoresearch-profit-target-8r6w6` remained in `Error`, but that was audit debt rather than a
  current trading authority.
- Direct Torghut database exec was not available from this worker because the service account cannot create
  `pods/exec`.

### Live Data Evidence

- Live `/trading/health` returned HTTP `503` with `status=degraded`.
- Live dependencies were mostly healthy: Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe,
  readiness cache, and broker status were OK.
- Live submission gate was closed with `simple_submit_disabled`, capital stage `shadow`, and live submit disabled.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live TCA had `7334` orders, `7245` filled executions, latest TCA around `2026-05-07T14:23:43Z`,
  average absolute slippage about `13.82 bps`, guardrail `8 bps`, zero routeable symbols, five blocked symbols, and
  three missing symbols.
- Live blocked symbols were `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA`; missing symbols were `AMZN`, `GOOGL`, and
  `ORCL`.
- Live quant evidence for `PA3SX7FYNUTF/15m` had `144` latest metrics updated around `19:08:41Z`, but stage health was
  degraded: compute OK, ingestion lag `534758` seconds, materialization not OK.

### Simulation Data Evidence

- Simulation `/trading/health` returned HTTP `200` with `status=ok`, but proof floor remained `repair_only`.
- Simulation capital state was `zero_notional`, route state `repair_only`, and paper probe notional limit `0`.
- Simulation had one probing symbol, `NVDA`, with average absolute slippage about `5.58 bps`, but TCA was stale at
  about `90502` seconds and there was one unsettled execution.
- Simulation had seven missing symbols: `AAPL`, `AMD`, `AMZN`, `AVGO`, `GOOGL`, `INTC`, and `ORCL`.
- Simulation quant evidence for `TORGHUT_SIM/15m` had zero latest metrics, no stages, and an empty latest store alarm.
- Simulation market context was stale, alpha readiness had three shadow hypotheses, zero promotion-eligible
  hypotheses, and three rollback-required hypotheses.

## Source Assessment

- `services/torghut/app/trading/proof_floor.py` builds the conservative proof-floor receipt. It correctly keeps
  capital zero when quant, market context, alpha, TCA, or submission gates are degraded.
- `services/torghut/app/trading/route_reacquisition.py` builds a symbol-level repair book with candidate, missing,
  blocked, probing, and routeable states. It does not yet connect route repair to Jangar stage credits or quant
  freshness debt.
- `services/torghut/app/trading/submission_council.py` fetches typed Jangar quant health and classifies
  `quant_latest_metrics_empty`, `quant_pipeline_stages_missing`, `quant_metrics_update_missing`, and
  `quant_pipeline_degraded`.
- `services/torghut/app/trading/revenue_repair.py` maps blocker reasons into prioritized repair actions. It has the
  right vocabulary, but not the paper edge ledger that proves a repair created a measurable route/hypothesis outcome.
- Existing tests cover proof floor, route reacquisition, submission council, revenue repair digest, market context,
  and quant readiness. The missing regression surface is a ledger that ranks quant freshness debt and prevents paper
  rehearsal until receipts close.

## Problem

Torghut has repair signals, but not a single ledger that prices the repairs against paper edge recovery. The result is
that important blockers are visible but not sequenced:

1. Live routeability is zero, so live notional must stay zero.
2. Live quant metrics are fresh enough to be useful, but ingestion stage lag is more than six days.
3. Simulation quant latest metrics are empty, so the one `NVDA` probing path cannot become paper evidence.
4. Market context is stale in both live and simulation.
5. Alpha readiness has no promotion-eligible hypotheses.
6. Jangar has stale-stage/freeze debt, so Torghut should not infer paper authority from local repair progress.

The profitable path is to price each blocker by expected unblock value and enforce a receipt chain before paper
rehearsal.

## Alternatives Considered

### Option A: Promote The Simulation NVDA Probe To A Paper Rehearsal

Pros:

- Fastest visible trading feedback.
- Uses the only currently probing symbol.
- Could produce more TCA evidence quickly.

Cons:

- Simulation TCA is stale and has unsettled execution evidence.
- Quant latest metrics are empty and pipeline stages are missing.
- Market context and alpha readiness are not promotable.
- Jangar paper authority is still held.

Decision: reject. `NVDA` is a repair seed, not paper authority.

### Option B: Keep All Torghut Repair Closed Until Jangar Stage Debt Clears

Pros:

- Safest coordination with Jangar.
- Avoids adding another ledger.
- No chance of confusing repair work with paper readiness.

Cons:

- Lets quant, market context, and route debt age further.
- Prevents zero-notional repair from producing the evidence Jangar needs.
- Makes profitability depend on waiting instead of falsifiable repair.

Decision: reject. Zero-notional evidence repair should continue under Jangar credit constraints.

### Option C: Add Quant Freshness Debt And Paper Edge Ledgers

Pros:

- Keeps capital zero while ranking repair work by expected edge recovery.
- Connects Torghut blockers to Jangar stage-debt credits.
- Separates quant freshness, route TCA, market context, alpha readiness, and paper edge receipts.
- Gives deployers a concrete promotion checklist.

Cons:

- Adds one more status payload and tests.
- Requires consistent receipt IDs across proof floor, route reacquisition, quant health, and Jangar status.
- Paper promotion remains slower until receipts close.

Decision: select Option C.

## Architecture

Add a pure reducer named `quant_freshness_debt_ledger` under `services/torghut/app/trading/`.

Inputs:

- Profitability proof-floor receipt.
- Route reacquisition book.
- Typed Jangar quant health for live and simulation accounts.
- Market-context freshness status.
- Alpha readiness payload.
- Revenue repair digest.
- Jangar `stage_debt_clearinghouse` summary.
- Jangar source rollout truth and proof-floor action receipts.

Output shape:

```text
quant_freshness_debt_ledger
  schema_version
  generated_at
  account_label
  trading_mode
  jangar_stage_credit_ref
  capital_state
  max_notional
  ledger_state                  # repair_only, paper_candidate, paper_ready, blocked
  debts[]
    debt_id
    debt_class                  # live_quant_ingestion, simulation_quant_empty, market_context, route_tca, alpha
    blocker_reason
    blocker_age_seconds
    expected_unblock_value
    capital_risk
    required_receipts[]
    repair_action
    max_notional
    rollback_trigger
  paper_edges[]
    edge_id
    symbol
    hypothesis_ids[]
    route_receipt_ref
    quant_receipt_ref
    market_context_receipt_ref
    alpha_receipt_ref
    jangar_credit_ref
    edge_state                  # seed, candidate, rehearsal_open, closed, rejected
    paper_probe_notional_limit
    required_after_evidence[]
  deployer_summary
    total_expected_unblock_value
    highest_value_debt
    paper_edge_count
    paper_ready_count
    live_blocking_reasons[]
    next_repair_actions[]
```

Debt ranking:

- Start with proof-floor repair ladder priority and expected unblock value.
- Add route reacquisition value: blocked symbols count double, missing symbols count once, probing symbols count triple.
- Add quant freshness penalty by blocker age and stage lag.
- Add market-context penalty when domain states are absent or stale.
- Add Jangar penalty when the matching stage credit is missing or expired.
- Never let score authorize notional. Score only orders repair work.

Paper edge admission requires:

- route receipt with fresh TCA, no unsettled execution, and at least one candidate symbol;
- quant receipt with latest metrics and pipeline stages healthy for the same account/window;
- market-context receipt fresh within policy;
- alpha readiness with at least one promotion-eligible hypothesis and no rollback-required blocker for that edge;
- Jangar stage-debt credit closed or healthy for the related stage;
- Jangar source rollout truth no longer holding `paper_canary`.

## Implementation Scope

Engineer stage should:

1. Add `quant_freshness_debt_ledger.py` as a pure reducer.
2. Feed it from proof floor, route reacquisition, quant evidence, market context, alpha readiness, and optional Jangar
   stage-debt status.
3. Expose the ledger in `/trading/status`, `/trading/health`, and `/trading/autonomy`.
4. Extend `revenue_repair.py` so the digest can include ledger debt IDs and paper edge IDs.
5. Add tests for live degraded, simulation empty-quant, stale market context, Jangar credit missing, and paper-ready
   receipt-chain cases.
6. Keep first rollout in shadow/status-only mode.

Deployer stage should:

1. Confirm live remains HTTP `503` or degraded while proof floor is repair-only.
2. Confirm simulation can be HTTP `200` without paper readiness.
3. Capture `quant_freshness_debt_ledger.deployer_summary` for live and simulation.
4. Confirm `max_notional=0` on every debt and paper edge while Jangar `paper_canary` is held.
5. Confirm the highest-ranked live repair is route/quant debt, not live submit.

## Validation Gates

Required local checks:

- `uv run --frozen pytest services/torghut/tests/test_quant_freshness_debt_ledger.py`
- `uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py services/torghut/tests/test_route_reacquisition.py services/torghut/tests/test_submission_council.py`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
- `bunx oxfmt --check docs/torghut/design-system/v6/165-torghut-quant-freshness-debt-and-paper-edge-ledgers-2026-05-07.md`

Required read-only runtime checks:

- `curl -sS -w '\\nHTTP_STATUS:%{http_code}\\n' http://torghut.torghut.svc.cluster.local/trading/health`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.quant_freshness_debt_ledger.deployer_summary'`
- `curl -fsS http://torghut-sim.torghut.svc.cluster.local/trading/status | jq '.quant_freshness_debt_ledger.deployer_summary'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m'`

Acceptance gates:

- Live degraded state does not authorize submit.
- Simulation OK state does not imply paper-ready when quant metrics are empty.
- Missing Jangar stage credit blocks paper edge readiness.
- Fresh quant metrics with stale ingestion create quant debt, not paper readiness.
- Paper edge readiness requires all receipts and zero unsettled executions.

## Rollout Plan

Phase 0, design acceptance:

- Merge this contract with the Jangar stage-debt contract.
- Publish engineer and deployer gates.

Phase 1, shadow:

- Emit the ledger in status and health payloads.
- Compare ranking against proof-floor repair ladder for one market session.
- No trading decisions change.

Phase 2, warn:

- Surface top repair debts in deployer/operator output.
- Require a Jangar stage credit ref before any repair work is described as paper-candidate.
- Keep `max_notional=0`.

Phase 3, enforce:

- Paper rehearsal requires closed receipt chain.
- Live micro-canary remains blocked until paper edges close cleanly and Jangar paper authority is no longer held.

## Rollback Plan

- Disable with `TORGHUT_QUANT_FRESHNESS_DEBT_LEDGER_MODE=off`.
- Keep existing proof-floor, route reacquisition, and submission gates.
- Continue zero-notional repair-only posture.
- If a paper edge is incorrectly marked ready, invalidate the edge ID and require fresh quant, market context, TCA,
  alpha, and Jangar receipts after the rollback timestamp.
- If status payload size is high, return only deployer summary and top five debts while preserving full ledger in
  internal diagnostics.

## Trading Hypotheses And Guardrails

Hypothesis 1: Repairing live quant ingestion lag increases usable route evidence.

- Measure: ingestion stage lag falls below one cadence and live quant stages are all OK.
- Guardrail: no live submit; max notional remains `0`.
- Falsifier: route universe remains zero after quant ingestion is current.

Hypothesis 2: Filling simulation quant latest metrics converts `NVDA` from probing seed to paper edge candidate.

- Measure: `TORGHUT_SIM/15m` latest metrics count becomes non-zero, stages exist, and unsettled execution count is zero.
- Guardrail: paper probe notional remains `0` until market context and alpha receipts close.
- Falsifier: `NVDA` remains blocked after quant, TCA, market context, and alpha receipts are fresh.

Hypothesis 3: Market-context refill reduces false promotion pressure.

- Measure: market-context freshness receipts are present for paper edge symbols and stale alerts clear.
- Guardrail: no edge can become paper-ready with absent domain states.
- Falsifier: alpha readiness stays at zero promotion-eligible after context refresh.

## Risks And Tradeoffs

- Ledger sprawl risk: many debts can clutter status. Mitigation: deployer summary ranks only the highest value items.
- Receipt mismatch risk: Jangar and Torghut may disagree on refs. Mitigation: missing or expired Jangar refs block paper
  edge readiness.
- Profitability overfitting risk: repair value can overstate actual edge. Mitigation: every hypothesis has a falsifier
  and zero-notional guardrail.
- Live/simulation confusion risk: simulation OK can look promotable. Mitigation: ledger state is separate from service
  health and requires paper receipt chain.

## Handoff To Engineer

Build the ledger as a pure reducer and keep all notional at zero. Wire it to existing proof-floor and route
reacquisition payloads before touching submission logic. The first useful test is the current shape: live has fresh
latest metrics but stale ingestion, simulation has no latest metrics, and both remain repair-only.

## Handoff To Deployer

After shadow deploy, capture live and simulation ledger summaries next to Jangar `stage_debt_clearinghouse`. Do not
treat simulation HTTP `200` as paper readiness. Promotion requires the receipt chain, no unsettled executions, fresh
market context, promotion-eligible alpha, and Jangar paper authority.
