# 168. Torghut Executable Alpha Receipts And Capital Replay Board (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut profitability, executable alpha receipt custody, zero-notional capital replay, scoped hypothesis
measurement, Jangar contract-graduation consumption, validation, rollout, rollback, and handoff.

Companion Jangar contract:

- `docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md`

Extends:

- `167-torghut-scoped-profit-repair-options-and-freshness-debt-retirement-2026-05-07.md`
- `166-torghut-paper-edge-witness-notary-and-zero-notional-repair-queue-2026-05-07.md`
- `166-torghut-executable-profit-receipts-and-repair-convoy-settlement-2026-05-07.md`
- `165-torghut-quant-freshness-debt-and-paper-edge-ledgers-2026-05-07.md`

## Decision

I am selecting **executable alpha receipts with a zero-notional capital replay board** as Torghut's next profitability
architecture step.

Torghut is available but not profit-ready. The live service rolled to `torghut-00284`; the sim service rolled to
`torghut-sim-00384`; both deployments are available. The database schema is current. The trading loop is running. But
live `/trading/health` returns HTTP 503 because the service is correctly degraded: live submit is disabled, proof floor
is `repair_only`, capital state is `zero_notional`, alpha readiness has zero promotion-eligible hypotheses, empirical
jobs are stale, market context is stale, and execution TCA route coverage is incomplete. Live quant latest metrics are
fresh, but the quant pipeline is degraded because ingestion lag is more than 542,000 seconds. Simulation has a better
NVDA TCA shape but still has an empty scoped quant latest store, stale TCA, one unsettled execution, and seven missing
symbols.

The next profitability move is not to widen paper. It is to make every proposed alpha repair executable as a measured,
zero-notional receipt. Torghut already publishes a proof floor and route-reacquisition book. It does not yet publish
the accepted `paper_edge_witness_notary`, `zero_notional_repair_queue`, `scoped_profit_repair_option_book`, or
freshness debt retirement receipts. The capital replay board closes that gap by requiring each candidate hypothesis to
name the before state, the replay action, the after state, the expected profit unlock, and the guardrail that would
falsify it. Jangar consumes those receipts through the contract graduation brake before paper or live action can widen.

The tradeoff is slower experimentation. I accept that because paper tests without executable receipts would only prove
that the system can submit paper orders while its evidence chain is stale. Profitability improves when we can compare
zero-notional repairs by measured alpha unlock and cost before introducing notional.

## Success Metrics

Success means:

- `/trading/status`, `/trading/health`, and `/trading/autonomy` emit an `executable_alpha_receipts` summary and a
  `capital_replay_board`.
- Every executable alpha receipt is scoped to `account_label`, `trading_mode`, `symbol_set`, `strategy_refs`,
  `proof_window`, `torghut_revision`, and `jangar_contract_graduation_ref`.
- Every receipt includes `before_refs`, `replay_action`, `after_refs`, `measured_delta`, `profit_hypothesis`,
  `guardrail_result`, `remaining_blockers`, and `capital_effect`.
- Every replay item has `max_notional=0` while proof floor is `repair_only`.
- Paper canary remains held until at least two receipts graduate from `reduced` or `retired` scoped debt into
  `paper_replay_candidate`, Jangar contract graduation is current, empirical jobs are fresh, market context is fresh,
  and route/TCA guardrails pass.
- Live micro-canary remains blocked until paper replay produces closed receipts with no stale or contradicted proof
  dimensions and Jangar no longer blocks live capital action classes.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRuns, broker state, Torghut flags, or ClickHouse data.

### Runtime And Cluster Evidence

- Argo CD reported `torghut` as `Synced`, `Healthy`, and operation `Succeeded` at
  `50106870a1cf3ef983306b77023e71e9ec8830fd`.
- Live `torghut-00284-deployment` and sim `torghut-sim-00384-deployment` were both `1/1` on image digest
  `sha256:014b9a46cd6690a9fd689b2e5cb170c35148c258358dfe53f3b86a46977c8421`.
- Torghut options catalog, options enricher, TA, TA sim, WebSocket services, ClickHouse, Keeper, Postgres, Symphony,
  and guardrail exporters were running.
- Recent rollout events showed completed DB migrations and transient startup/readiness probe failures during revision
  creation. The latest live and sim deployments became available after those probes cleared.
- One retained `torghut-whitepaper-autoresearch-profit-target` pod remained in `Error`; this is audit evidence, not a
  current trading gate by itself.
- Direct CNPG cluster reads and `pods/exec` were forbidden, so `/db-check`, typed trading routes, Jangar quant health,
  and Kubernetes rollout/event reads are the available evidence surfaces.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, expected and current head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, one schema branch, and lineage-ready
  graph.
- The schema graph still warned about parent forks at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Account-scope checks were ready only because multi-account trading is disabled; the route explicitly reported that
  account-scope checks are bypassed under that setting.
- Jangar status database projection was healthy with 28 registered and 28 applied migrations, latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar dependency quorum blocked on `empirical_jobs_degraded`.
- Jangar scoped quant health for live account `PA3SX7FYNUTF` and `15m` was `degraded`: latest metrics count was 144,
  latest metrics updated at `2026-05-07T21:10:27.101Z`, compute was OK, ingestion lag was `542071` seconds, and
  materialization was not OK.
- Jangar scoped quant health for `TORGHUT_SIM` and `15m` was `degraded`: latest metrics count was zero, no latest
  metrics timestamp existed, and no stages were present.

### Profitability Evidence

- Live mode was `live`, running and enabled; autonomy was disabled and kill switch was off.
- Live `/trading/health` returned HTTP 503 with service `status=degraded`, even though Postgres, ClickHouse, Alpaca,
  universe, and readiness cache were OK.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live proof-floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_incomplete`, `market_context_stale`, and `simple_submit_disabled`.
- Live route-reacquisition had one probing candidate, `AAPL`, and seven repair candidates. `NVDA`, `AMD`, `INTC`, and
  `AVGO` were blocked by route/TCA evidence; `AMZN`, `GOOGL`, and `ORCL` were missing TCA symbol evidence.
- Live TCA had 7334 orders and 7245 filled executions. Average absolute slippage was about `13.82 bps` against an
  `8 bps` guardrail. Symbol examples: `AAPL=9.25`, `NVDA=13.48`, `AMD=14.93`, `INTC=20.57`, and `AVGO=21.86` bps.
- Simulation mode was `paper`, running and enabled; proof floor was also `repair_only` and `zero_notional`.
- Simulation had one probing path, `NVDA`, with average absolute slippage about `5.58 bps`, but TCA was stale at
  `2026-05-06T18:00:43Z`, one execution was unsettled, seven symbols were missing, market context was stale, alpha
  readiness had zero promotion-eligible hypotheses, and scoped quant health was empty.
- Neither live nor sim status emitted `paper_edge_witness_notary` or `zero_notional_repair_queue`.

### Source Evidence

- `services/torghut/app/main.py` is 4188 lines and is already a high-risk aggregation point. New policy should live in
  small trading modules and be projected by routes, not embedded directly in the route file.
- `services/torghut/app/trading/proof_floor.py` is 701 lines and already keeps capital zero when proof dimensions fail
  or degrade.
- `services/torghut/app/trading/route_reacquisition.py` is 374 lines and already builds symbol-level probing, blocked,
  and missing states from proof-floor dimensions.
- `services/torghut/app/trading/revenue_repair.py` is 670 lines and summarizes repair economics, but it does not yet
  emit executable alpha receipts with before/after replay evidence and Jangar graduation refs.
- `services/torghut/app/trading/submission_council.py` is 1199 lines and already loads typed Jangar quant health and
  classifies degraded or empty scoped quant evidence.
- Tests cover proof floor, route reacquisition, quant evidence, submission council, trading API projection, and revenue
  repair digest. The missing regression surface is executable alpha receipt generation that refuses to promote a
  superficially good route when scoped quant, market context, empirical, alpha, or Jangar graduation proof is missing.

## Problem

Torghut has a conservative proof floor, but it does not yet have an executable alpha accounting layer. The current
system can say why capital is held. It cannot yet say which zero-notional replay would most likely create a tradable
edge after cost.

That gap matters because the current surface has partial positives:

- Live AAPL has route evidence, but it is still only probing because dependency receipts block capital.
- Simulation NVDA has acceptable average absolute slippage, but scoped quant is empty and TCA is stale.
- Live quant latest metrics are fresh, but ingestion is badly stale.
- Empirical jobs are completed, but stale against the current authority window.
- Database schema is current, but account-scope checks are bypassed while multi-account trading is disabled.

Any one of those positives can be over-weighted by a human operator. Executable receipts make the system prove the
whole chain before a candidate becomes paper-eligible.

## Alternatives Considered

### Option A: Promote The Best-Looking Paper Candidate

Use simulation NVDA or live AAPL as the next paper rehearsal candidate because each has at least one promising route
signal.

Advantages:

- Fastest path to visible trading behavior.
- Exercises downstream paper plumbing.
- Produces new operational evidence quickly.

Disadvantages:

- Simulation NVDA has empty scoped quant evidence, stale TCA, one unsettled execution, and stale market context.
- Live AAPL is still probing, not routeable for capital, and sits behind stale empirical and market-context proof.
- Jangar contract graduation is not live, so paper would not have a graduated control-plane witness.

Decision: reject. Both are repair targets, not paper candidates.

### Option B: Run A Broad Refresh Wave

Rerun empirical jobs, quant materialization, market-context refresh, route/TCA recompute, and alpha readiness in one
large repair pass.

Advantages:

- Directly attacks the visible blockers.
- May clear several proof dimensions at once.
- Simple for an operator to understand.

Disadvantages:

- Does not measure repair value by hypothesis or symbol set.
- Can spend compute on surfaces that the next gate still cannot consume.
- Does not create before/after receipts tied to Jangar graduation.

Decision: useful when selected by the replay board, but not sufficient as the architecture.

### Option C: Executable Alpha Receipts And Capital Replay Board

Emit a zero-notional replay board and require every alpha candidate to graduate through executable receipts before
paper or live capital can widen.

Advantages:

- Converts repair work into measurable hypotheses.
- Keeps every replay zero-notional while proof floor is repair-only.
- Gives Jangar a concrete receipt to consume through contract graduation.
- Lets Torghut compare AAPL route rehabilitation, NVDA sim proof refill, and missing-symbol probes on cost and unlock
  value.
- Makes rollback mechanical: if a receipt is stale, contradicted, failed, or unchanged, capital stays zero.

Disadvantages:

- Adds another reducer and receipt schema.
- Requires careful TTLs for before and after refs.
- Will delay paper even when a single symbol looks attractive.

Decision: select Option C.

## Architecture

### CapitalReplayBoard

Torghut emits one board per account, mode, proof window, and Jangar graduation brake id.

```text
capital_replay_board
  schema_version
  board_id
  account_label
  trading_mode
  proof_window
  torghut_revision
  jangar_contract_graduation_ref
  generated_at
  fresh_until
  replay_items
  selected_replays
  blocked_capital_surfaces
  rollback_target
```

Each replay item includes:

```text
capital_replay_item
  replay_id
  hypothesis_id
  target_symbols
  replay_class
  before_refs
  required_after_refs
  expected_profit_unlock
  expected_cost
  confidence
  max_runtime_seconds
  max_notional
  guardrails
  falsification_rules
  owner
```

`max_notional` is always `0` while proof floor is `repair_only`.

### ExecutableAlphaReceipt

A replay item only matters after it produces a receipt:

```text
executable_alpha_receipt
  receipt_id
  replay_id
  hypothesis_id
  account_label
  trading_mode
  target_symbols
  started_at
  completed_at
  before_refs
  after_refs
  measured_delta
  guardrail_result
  graduation_state
  jangar_contract_graduation_ref
  remaining_blockers
  capital_effect
```

Graduation states:

- `candidate`: enough before refs exist to run a zero-notional replay.
- `reduced`: replay improved a blocker but did not clear it.
- `paper_replay_candidate`: replay cleared all scoped zero-notional gates, but paper has not run.
- `retired`: replay retired the scoped debt it targeted.
- `unchanged`: replay completed without useful movement.
- `failed`: replay did not produce valid after refs.
- `contradicted`: after refs conflict with another proof source.

### Initial Measurable Hypotheses

The first board should carry three executable hypotheses.

`H-AAPL-ROUTE-REHAB`

- Thesis: AAPL is the closest live candidate because it is probing and has current TCA rows.
- Before refs: live route-reacquisition record for AAPL, TCA slippage `9.25 bps`, proof-floor blockers, stale empirical
  receipts, market-context stale state, and Jangar contract graduation row.
- Replay action: zero-notional route/TCA recompute plus market-context and empirical receipt refresh.
- Guardrail: average absolute slippage must be at or below `8 bps`, all required receipts fresh, and capital remains
  zero.

`H-NVDA-SIM-PROOF-REFILL`

- Thesis: NVDA simulation has acceptable route shape at `5.58 bps`, but cannot be paper-promoted until scoped proof is
  fresh.
- Before refs: sim NVDA route record, empty `TORGHUT_SIM` quant latest store, stale TCA, one unsettled execution, and
  stale market context.
- Replay action: refill scoped quant metrics/stages, settle sim TCA, and rerun alpha readiness after proof refresh.
- Guardrail: no unsettled executions, scoped latest metrics non-empty, TCA fresh, and no notional.

`H-MEGACAP-BREADTH-PROBE`

- Thesis: missing-symbol probes can improve future route coverage without pretending they are profitable yet.
- Before refs: live missing symbols `AMZN`, `GOOGL`, `ORCL` and sim missing symbols `AAPL`, `AMD`, `AMZN`, `AVGO`,
  `GOOGL`, `INTC`, `ORCL`.
- Replay action: create zero-notional simulation probes and recompute route/TCA coverage.
- Guardrail: probes cannot produce paper eligibility by themselves; they only retire missing-symbol debt.

## Validation Gates

Engineer gates:

- Add pure Torghut reducers for `capital_replay_board` and `executable_alpha_receipt`.
- Keep route assembly in `services/torghut/app/main.py` thin; policy belongs in `services/torghut/app/trading/`.
- Unit tests must cover live AAPL probing, sim NVDA with empty quant store, missing-symbol breadth probes, stale
  empirical jobs, stale market context, TCA above guardrail, and missing Jangar contract graduation.
- Tests must prove every replay item has `max_notional=0`, before refs, required after refs, guardrails, and a rollback
  target.
- Tests must prove a superficially attractive replay cannot become `paper_replay_candidate` while any required scoped
  proof is missing, stale, contradicted, or ungraduated in Jangar.

Deployer gates:

- Before enabling any replay, capture `/trading/status`, `/trading/health`, `/db-check`, Jangar control-plane status,
  Jangar scoped quant health for live and sim, and recent Torghut rollout events.
- Enable only replay classes selected by the board, with no notional and bounded runtime.
- Reject paper canary until at least two executable receipts are `paper_replay_candidate` or `retired`, all mandatory
  Jangar contract rows are graduated, and proof floor is no longer `repair_only`.
- Reject live micro-canary until paper receipts are closed and live route/TCA, market context, empirical jobs, alpha
  readiness, submission gate, and Jangar material action verdicts agree.

## Rollout

1. Add board and receipt reducers with additive route projection.
2. Seed board rows for AAPL route rehab, NVDA sim proof refill, and megacap breadth probes.
3. Run route tests and service tests without enabling any replay execution.
4. Deploy the route field in observation mode.
5. Allow zero-notional replay execution only after Jangar contract graduation sees the fields.
6. Keep paper and live capital unchanged until receipt gates and proof floor both clear.

## Rollback

- If reducer assembly fails, omit the board and keep proof floor `repair_only`.
- If any replay emits malformed refs, mark the receipt `failed` and keep capital zero.
- If a replay improves one metric but leaves another stale, mark it `reduced`, not `retired`.
- If Jangar contract graduation is missing or stale, all replay receipts remain non-capital evidence.
- If paper replay creates contradictory evidence, return the hypothesis to shadow and keep live capital blocked.

## Risks

- Overfitting to AAPL or NVDA: the first board uses current evidence, not permanent priority. The board must re-rank on
  every proof window.
- False precision: expected profit unlock is an estimate. The receipt must record measured delta and guardrail result,
  not just expected value.
- Receipt bloat: every replay can create many refs. Keep the route summary compact and store large artifacts behind
  refs.
- Stale before refs: a replay must expire if it starts after its before refs age out.

## Handoff

Engineer stage should implement the two pure reducers, expose additive route fields, and add focused regression tests.
Deployer stage should treat the first rollout as observation-only and verify that live remains `repair_only`,
`zero_notional`, paper canary held, and live capital blocked until executable receipts and Jangar contract graduation
both close.
