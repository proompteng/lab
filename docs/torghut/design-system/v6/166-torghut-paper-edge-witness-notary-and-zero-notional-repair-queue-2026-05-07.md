# 166. Torghut Paper Edge Witness Notary And Zero-Notional Repair Queue (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability, paper-edge witness custody, zero-notional repair ranking, Jangar contract witness
consumption, validation, rollout, rollback, and engineer/deployer acceptance gates.

Companion Jangar contract:

- `docs/agents/designs/162-jangar-contract-witness-notary-and-material-action-gates-2026-05-07.md`

Extends:

- `165-torghut-quant-freshness-debt-and-paper-edge-ledgers-2026-05-07.md`
- `165-torghut-outcome-priced-repair-market-and-capital-shadow-swaps-2026-05-07.md`
- `164-torghut-zero-notional-route-repair-packets-and-paper-rehearsal-2026-05-07.md`
- `158-torghut-route-reacquisition-and-market-context-repair-cells-2026-05-07.md`

## Decision

I am selecting a paper-edge witness notary with a zero-notional repair queue as the next Torghut profitability
architecture step.

Torghut is serving, but it is not paper-ready or live-capital-ready. Live mode is enabled and the kill switch is off,
but active capital stage is still `shadow`. Proof floor is `repair_only`, capital state is `zero_notional`, live submit
is disabled, empirical jobs are stale, market context is stale, alpha readiness has no promotion-eligible hypotheses,
and routeability is zero of eight live symbols. Simulation is safer operationally, but it is also not promotable:
`TORGHUT_SIM` has an empty latest quant store, stale TCA, one `NVDA` probing path, seven missing symbols, and one
unsettled execution.

The profitable move is to rank zero-notional repair work by the paper edge it can unlock after receipts close. A live
symbol with high slippage is not a paper candidate. A simulation symbol with acceptable TCA but empty quant receipts is
not a paper candidate. A fresh market-context provider response is not enough when the bundle domains are stale. The
system needs one witness notary that says why a symbol/account/window is not eligible yet, and one repair queue that
orders the work without granting notional.

The tradeoff is delayed paper experimentation. I accept that. Paper runs that are allowed before quant, market-context,
TCA, empirical, alpha, and Jangar witnesses close would create false evidence. A zero-notional queue lets Torghut spend
engineering and runner capacity on repairs whose after-state is measurable, while keeping trading capital fenced off.

## Runtime Objective And Success Metrics

Success means:

- `/trading/status`, `/trading/health`, and `/trading/autonomy` expose `paper_edge_witness_notary` and
  `zero_notional_repair_queue`.
- Every paper-edge witness is scoped to `account_label`, `symbol`, `window`, `strategy_id` or hypothesis set, and
  `torghut_revision`.
- A witness records `quant_receipt`, `market_context_receipt`, `tca_route_receipt`, `empirical_receipt`,
  `alpha_readiness_receipt`, `submission_receipt`, and `jangar_contract_witness_ref`.
- A witness state is one of `candidate`, `repair_only`, `missing_quant`, `missing_market_context`, `missing_tca`,
  `empirical_stale`, `alpha_not_ready`, `submission_closed`, `jangar_hold`, or `blocked`.
- The queue ranks repairs by expected paper-edge unlock value, proof age, symbol coverage, blocker count, confidence,
  and cost.
- Every queue item has `max_notional=0`, `before_ref`, `required_after_ref`, `rollback_target`, `ttl_seconds`, and
  `owner`.
- Live paper rehearsal is closed until at least two symbols have current witnesses with fresh quant, market-context,
  TCA, empirical, alpha, submission, and Jangar contract evidence.
- Live micro-canary remains blocked until paper rehearsal produces two closed zero-notional receipts and Jangar no
  longer holds `paper_canary`.
- Deployer can reject any paper or live promotion with one witness ID and one repair queue ID.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 from 20:06Z to 20:11Z. I did not mutate Kubernetes resources,
database records, ClickHouse data, broker state, GitOps resources, AgentRun objects, or trading flags.

### Runtime And Cluster Evidence

- Argo CD reported `torghut` as `Synced`, `Healthy`, and operation `Succeeded` at revision
  `5549fe9bb4f34cac56f5db3619b0cb53405b7783`.
- Current live revision `torghut-00280-deployment` was `1/1`; current simulation revision
  `torghut-sim-00380-deployment` was `1/1`.
- Torghut options catalog, options enricher, TA, TA simulation, WebSocket services, ClickHouse, Keeper, Postgres, and
  exporters were running.
- Recent Torghut events showed readiness and startup probe noise during rollout handoff, followed by current revision
  readiness.
- Recent Torghut events also showed completed empirical backfill and whitepaper semantic backfill jobs.
- The worker service account could not list Knative services in `torghut`, so deployment/pod/service/event evidence
  and HTTP route probes were the available read-only witnesses.
- Direct CNPG status and `psql` were blocked by RBAC because `agents-sa` cannot get CNPG clusters or create
  `pods/exec` in the `torghut` namespace.

### Live Data Evidence

- Live `/trading/status` reported `mode=live`, `running=true`, `enabled=true`, `kill_switch_enabled=false`, and
  `autonomy_enabled=false`.
- Live active revision was `torghut-00280`; universe resolution was OK through Jangar cache with eight symbols.
- Critical toggles were aligned for live: trading enabled, autonomy disabled, live promotion disabled, kill switch off,
  and `TRADING_MODE=live`.
- Active capital stage was `shadow`; `alpha_readiness_promotion_eligible_total=0` and
  `alpha_readiness_rollback_required_total=3`.
- Empirical jobs were degraded because `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` were stale from `2026-05-06T16:27:32Z`.
- Live quant health for `PA3SX7FYNUTF/15m` had `latestMetricsCount=144` and metrics updated at
  `2026-05-07T20:10:13.985Z`, but status was degraded. Compute was OK; ingestion lag was `538452` seconds and
  materialization was not OK.
- Live proof floor was `repair_only`, route state was `repair_only`, capital state was `zero_notional`, and
  `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live TCA had `7334` orders, `7245` filled executions, latest TCA at `2026-05-07T14:23:43Z`, average absolute
  slippage about `13.82 bps`, and slippage guardrail `8 bps`.
- Live routeability had zero routeable symbols. `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA` were blocked; `AMZN`,
  `GOOGL`, and `ORCL` were missing.
- Market-context health for `NVDA` had healthy provider attempts, but overall state was degraded. Technicals,
  fundamentals, news, and regime were stale.

### Simulation Data Evidence

- Simulation `/trading/status` reported `mode=paper`, `running=true`, `enabled=true`, `kill_switch_enabled=false`,
  and `autonomy_enabled=false`.
- Simulation critical toggle parity diverged on `TRADING_MODE`; expected was `live`, effective was `paper`.
- Simulation proof floor was `repair_only`, route state was `repair_only`, capital state was `zero_notional`, and
  `paper_probe_notional_limit=0`.
- Simulation quant health for `TORGHUT_SIM/15m` had zero latest metrics, no stages, and an empty latest store alarm.
- Simulation routeability had one `NVDA` probing path, seven missing symbols, stale TCA, and one unsettled execution.
- Simulation TCA average absolute slippage for `NVDA` was about `5.58 bps`, below the `8 bps` guardrail, but the
  witness is not enough because quant, market context, alpha readiness, and empirical receipts are not current.
- Simulation signal continuity was expected market-closed staleness, not an actionable live alert.

## Source Assessment

- `services/torghut/app/trading/proof_floor.py` is the conservative capital firewall. It correctly keeps live and
  simulation capital zero when any critical proof dimension is degraded.
- `services/torghut/app/trading/route_reacquisition.py` already builds symbol-level states for blocked, missing,
  probing, and routeable paths. It should supply route receipts to the paper-edge witness notary.
- `services/torghut/app/trading/submission_council.py` already classifies Jangar quant health states such as empty
  latest metrics, missing updates, and degraded pipeline stages.
- `services/torghut/app/trading/revenue_repair.py` and the newest repair-market designs have the right economic
  vocabulary, but they do not yet produce a single paper-edge witness per symbol/account/window.
- `services/torghut/app/main.py` is large and already carries many status fields. The new queue should be assembled
  by small trading modules and only projected through the route.
- Existing tests cover proof floor, route reacquisition, submission council, empirical jobs, market context, and
  quant readiness. The missing regression surface is a paper-edge witness that refuses a superficially promising
  candidate when any required receipt is missing or stale.

## Problem

Torghut has too many partial proofs and not enough promotion custody. Live has current quant latest metrics, but
ingestion is deeply stale and routeability is zero. Simulation has a better `NVDA` route shape, but empty quant metrics
and stale TCA. Market-context providers can respond, but domain states are stale. Alpha readiness counts hypotheses,
but none are promotion eligible.

Without one witness object, a paper promotion can be argued from the strongest partial proof in the payload. That is
the wrong incentive. Paper should require agreement across quant, market-context, TCA, empirical, alpha, submission,
and Jangar contract witnesses. Repairs should compete by the number and value of receipts they can close.

## Options Considered

### Option A: Promote The Simulation NVDA Path To Paper Rehearsal

This option uses the simulation `NVDA` probing path because its average absolute slippage is below the guardrail.

Advantages:

- Fastest path to a visible paper experiment.
- Uses a concrete symbol with nonzero route evidence.
- Exercises the newer route-reacquisition book.

Disadvantages:

- Quant latest metrics are empty for `TORGHUT_SIM`.
- TCA is stale and there is one unsettled execution.
- Market context and alpha readiness are not current.
- Jangar still holds `paper_canary`.

Decision: reject. The `NVDA` path is a repair target, not a paper candidate.

### Option B: Refresh Empirical Jobs First

This option focuses only on the four stale empirical jobs.

Advantages:

- Removes a major Jangar dependency-quorum blocker.
- Produces useful proof for both live and simulation.
- Fits existing empirical job infrastructure.

Disadvantages:

- Does not fix routeability, market context, quant ingestion, alpha readiness, or submission closure.
- Could create fresh empirical proof that still cannot be used for paper.
- Does not tell which symbol/account/window should be repaired next.

Decision: necessary work, but not sufficient architecture.

### Option C: Paper-Edge Witness Notary With Zero-Notional Repair Queue

This option emits one witness per symbol/account/window and ranks zero-notional repairs by expected paper-edge unlock.

Advantages:

- Prevents partial proof promotion.
- Gives engineers a ranked repair queue with finite receipts.
- Keeps every repair zero-notional until all gate witnesses close.
- Connects Torghut paper eligibility to Jangar contract witness custody.
- Makes live and simulation comparable without pretending their risks are the same.

Disadvantages:

- Adds another status projection.
- Requires careful receipt naming and TTL policy.
- Can be too conservative if optional witnesses are configured as mandatory.

Decision: select Option C.

## Architecture

### Paper-Edge Witness

Torghut emits one witness for every candidate symbol/account/window that appears in the route book, hypothesis set, or
quant latest store.

```text
paper_edge_witness
  witness_id
  account_label
  symbol
  window
  strategy_refs
  torghut_revision
  state                         # candidate, repair_only, missing_quant, missing_market_context, ...
  max_notional
  quant_receipt
  market_context_receipt
  tca_route_receipt
  empirical_receipt
  alpha_readiness_receipt
  submission_receipt
  jangar_contract_witness_ref
  blocker_reason_codes
  required_after_refs
  fresh_until
  rollback_target
```

Witnesses are not trading decisions. They are custody objects that explain why a candidate is or is not paper-eligible.

### Zero-Notional Repair Queue

The repair queue ranks witness gaps:

```text
zero_notional_repair_queue_item
  queue_id
  witness_id
  repair_class                  # quant_ingestion, market_context, route_tca, empirical, alpha, submission, jangar
  target_blocker
  before_ref
  required_after_ref
  expected_paper_edge_unlock
  expected_cost
  confidence
  max_notional                  # always 0 while proof floor is repair_only
  owner
  ttl_seconds
  rollback_target
```

Ranking is deterministic:

1. Repairs that can unlock a paper candidate without live notional outrank live-only repairs.
2. Repairs that close multiple blockers outrank single-blocker repairs.
3. Freshness debt with known stale timestamps outranks unknown evidence debt.
4. Lower capital risk and lower runner cost break ties.
5. Jangar-held actions cannot outrank local repairs until the companion contract witness is current.

### Initial Queue From Current Evidence

The current queue should produce:

- `live:route_tca`: repair live route universe because zero of eight symbols are routeable and five exceed or lack the
  routeability proof needed for paper.
- `live:quant_ingestion`: repair `PA3SX7FYNUTF/15m` ingestion lag, even though latest metrics are present.
- `live:market_context`: refresh stale technicals, fundamentals, news, and regime.
- `live:empirical`: refresh the four stale empirical jobs.
- `simulation:quant_empty_store`: refill `TORGHUT_SIM/15m` latest metrics before any paper rehearsal.
- `simulation:tca_and_unsettled`: refresh stale TCA and settle the outstanding execution for the `NVDA` probing path.
- `simulation:missing_routes`: create zero-notional route probes for the seven missing symbols.
- `jangar:contract_witness`: wait for Jangar contract witness notary to stop holding `paper_canary`.

## Engineer Scope

1. Add `services/torghut/app/trading/paper_edge_witness.py` with pure functions for witness and queue construction.
2. Feed it from proof floor, route reacquisition, submission council quant evidence, market context, empirical jobs,
   alpha readiness, and the companion Jangar contract witness summary.
3. Project `paper_edge_witness_notary` and `zero_notional_repair_queue` through `/trading/status`.
4. Include compact summaries in `/trading/health` and `/trading/autonomy`.
5. Add tests covering:
   - live zero routeable symbols stay repair-only;
   - simulation `NVDA` probing stays zero-notional with empty quant metrics;
   - fresh TCA alone cannot make a paper candidate;
   - Jangar `paper_canary` hold blocks paper eligibility;
   - queue ranking is deterministic.
6. Keep the queue read-only. Starting repair jobs remains an explicit operator or controller action outside this
   reducer.

## Validation Gates

Local validation:

- `uv run --frozen pytest services/torghut/tests/test_paper_edge_witness.py`
- `uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py services/torghut/tests/test_route_reacquisition.py services/torghut/tests/test_submission_council.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `bunx oxfmt --check docs/torghut/design-system/v6/166-torghut-paper-edge-witness-notary-and-zero-notional-repair-queue-2026-05-07.md`

Cluster validation after deploy:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.paper_edge_witness_notary.summary'`
- `curl -fsS http://torghut-sim.torghut.svc.cluster.local/trading/status | jq '.zero_notional_repair_queue.summary'`
- Confirm live has zero paper candidates and queue items for route TCA, quant ingestion, market context, empirical,
  alpha, submission, and Jangar hold.
- Confirm simulation `NVDA` is `repair_only` or `missing_quant`, not `candidate`, until quant latest metrics,
  market context, TCA, alpha, empirical, and Jangar witnesses close.
- Confirm every queue item has `max_notional=0` while proof floor is `repair_only`.

## Rollout Plan

1. Ship witness and queue projection in observe-only mode.
2. Compare queue ordering with existing proof-floor repair ladder for one full schedule cadence.
3. Enable health/autonomy summaries after the route payload is stable.
4. Allow zero-notional repair scheduling to cite queue IDs only after Jangar contract witness notary is present.
5. Keep paper and live promotion disabled until at least two paper-edge witnesses close with fresh receipts and Jangar
   `paper_canary` allows.

## Rollback Plan

- Remove the new status fields from promotion policy and keep proof floor as the capital authority.
- Keep route reacquisition, empirical jobs, market context, and submission council behavior unchanged.
- If queue ranking is wrong, disable scheduling by queue ID and continue emitting witnesses for audit.
- If payload size becomes too large, expose only the summary in `/trading/status` and move full witness rows to a
  detail endpoint.

## Risks

- The queue can become an allocator. Mitigation: it ranks repairs, not capital.
- The witness can overfit to current symbols. Mitigation: key by account, symbol, window, and strategy refs; do not
  hardcode semiconductor symbols.
- A stale Jangar witness can block local repair too broadly. Mitigation: allow local zero-notional evidence refresh
  when max notional is `0`, but keep paper and live blocked.
- Provider success can be mistaken for market-context freshness. Mitigation: require domain freshness receipts, not
  just provider attempts.
- Simulation and live can be compared incorrectly. Mitigation: separate account labels and route states in every
  witness.

## Handoff To Engineer And Deployer

Engineer owns the pure witness builder, queue ranking, status projection, and tests. The first implementation should
not schedule jobs or change capital gates; it should only expose the notary and queue.

Deployer owns post-deploy evidence. A rollout is acceptable only when live and simulation routes expose witness
summaries, all queue items remain zero-notional, simulation `NVDA` is not promoted from partial proof, and live paper
and live capital remain closed while Jangar holds `paper_canary`.
