# 103. Torghut Hypothesis Rehydration And Proof Gap Auction (2026-05-06)

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

Torghut should implement a **hypothesis rehydration runway backed by the Jangar proof-gap auction** before any paper or
live capital can reenter.

The current system is operational enough to repair itself. It is not profitable enough to trade. Torghut serves, the
schema is current, the active live revision is healthy, Jangar has fresh aggregate quant latest metrics, and options
services are available. The proof surface is the problem: there are zero rows in `strategy_hypotheses`, all 48
`research_runs` are skipped, only nine decisions exist in the last seven days and all are rejected, the latest execution
is from `2026-04-02`, all historical execution rows lack `execution_correlation_id`, Jangar dependency quorum blocks on
`empirical_jobs_degraded`, scoped account/window quant health has no pipeline stages, and market context is stale across
technical, fundamental, news, and regime domains.

The next profitable move is to rebuild an investable hypothesis inventory under proof budgets. Torghut should convert
each missing proof surface into a repair lot, run zero-notional or shadow micro-sessions to rehydrate hypotheses, retire
rejection and correlation debt, and publish compact receipts that Jangar can spend. Capital should remain a consequence
of closed proof gaps, not a toggle that races ahead of evidence.

The tradeoff is slower return to paper capital. I accept that because the current data says the system has no fresh
alpha chain to fund.

## Read-Only Evidence Snapshot

All evidence for this design pass was read-only. No Kubernetes resources, database rows, or broker controls were
changed.

### Cluster And Route Evidence

- `torghut` Argo CD application was `Synced/Healthy` after a fresh revision rollout.
- Torghut root route returned `status=ok`, version `v0.568.5-109-gd75217793`, and commit
  `d7521779328d92f1a2b90b5774c7d331448f7f6c`.
- Live revision `torghut-00227` was observed at `2/2 Running`; sim revision replacement still had a terminating
  `torghut-sim-00308` pod during the sample.
- Torghut Postgres, ClickHouse, Keeper, TA, WebSocket, options catalog, options enricher, options TA, and guardrail
  exporters were running.
- `torghut-ws` readiness returned ready with Alpaca WebSocket, Kafka, and trade-update gates true.
- Options catalog readiness returned ready but retained a recent SSL handshake timeout as `last_error_detail`.
- Options enricher readiness returned ready with last success at `2026-05-06T02:11:35Z`.
- Jangar `/ready` was healthy and runtime-kit collaboration evidence included NATS tooling.

### Data And Schema Evidence

- Torghut `/db-check` returned `ok=true`, `schema_current=true`, Alembic head
  `0029_whitepaper_embedding_dimension_4096`, account-scope readiness, and no schema-lineage errors. Known lineage
  parent-fork warnings remain present.
- Torghut SQL connected as `torghut_app` to database `torghut` at `2026-05-06T02:14:01Z`.
- `trade_decisions` had nine rows in the last seven days, all `rejected`, newest `2026-05-04T17:25:57.901Z`.
- Historical `trade_decisions` counted 69,909 `rejected`, 63,552 `blocked`, 13,555 `filled`, 370 `planned`, 217
  `canceled`, and 3 `expired` rows.
- Recent decisions were rejected for the active account label `PA3SX7FYNUTF` on symbols including AMD, AAPL, INTC, and
  NVDA.
- `executions` had 13,778 rows, newest `2026-04-02T20:59:45.104Z`; none were missing account labels, but all 13,778
  lacked `execution_correlation_id`.
- `research_runs` had 48 rows, all `skipped`, newest `2026-03-11T10:14:45.427Z`.
- `strategy_hypotheses` had zero rows.
- `torghut_options_watermarks` was recently analyzed and remains a usable options freshness plane, but fresh options data
  is not tied to a populated hypothesis inventory.
- Torghut `/trading/status` returned live mode, `last_decision_at=2026-05-04T17:25:57.901670Z`,
  `alpha_readiness_hypotheses_total=3`, `alpha_readiness_promotion_eligible_total=0`,
  `alpha_readiness_rollback_required_total=3`, and dependency quorum `block` for `empirical_jobs_degraded`.
- Torghut `/trading/health` returned degraded with `simple_submit_disabled`, capital stage `shadow`, and zero promotion
  eligible hypotheses.
- Jangar aggregate quant health for `window=1d` was OK with 540 latest metrics, but it omitted stage scope because
  account and window were not both provided.
- Jangar scoped quant health for `account=PA3SX7FYNUTF&window=1d` was OK with 108 latest metrics but
  `metricsPipelineLagSeconds=31658` and an empty `stages` array.
- Jangar market-context health for AAPL returned overall degraded with stale technical, fundamental, news, and regime
  domains.

### Source Evidence

- `services/torghut/app/trading/hypotheses.py` already models dependency capabilities, promotion eligibility, rollback
  requirement, and capital stage for runtime hypotheses.
- `services/torghut/app/trading/empirical_jobs.py` already classifies empirical readiness, stale jobs, and promotion
  authority.
- `services/torghut/app/trading/submission_council.py` already consumes typed quant health, dependency quorum,
  empirical jobs, promotion eligibility, and kill-switch state for live submission.
- `services/torghut/app/main.py` already exposes `/trading/status`, `/trading/health`, `/trading/empirical-jobs`,
  `/trading/autonomy/evidence-continuity`, `/trading/decisions`, `/trading/executions`, `/metrics`, and `/db-check`.
- Migration `0021_strategy_hypothesis_governance.py` created the `strategy_hypotheses` table, but production currently
  has no rows to fund.
- Migration `0012_lean_multilane_foundation.py` added execution correlation fields, but historical execution rows are
  not populated with `execution_correlation_id`.
- Existing tests cover empirical jobs, hypothesis governance, submission council, trading status, DB checks, options,
  quant readiness scripts, and trading API behavior. The missing regression is the rehydration loop: empty research and
  hypothesis tables must create repair lots, not capital eligibility.

## Problem

Torghut can name why capital is blocked, but it cannot yet turn those blockers into an investable repair sequence.

The capital lane is missing four forms of proof:

1. **Hypothesis inventory proof.** Runtime manifests mention three hypotheses, but the durable `strategy_hypotheses`
   table is empty.
2. **Research proof.** `research_runs` is skipped-only and stale, so no current promotion chain can justify a funded
   candidate.
3. **Execution proof.** Historical executions are old and lack correlation IDs, weakening TCA and replay attribution.
4. **Fresh context proof.** Scoped quant stage evidence is empty and market-context domains are stale.

The system should not respond by widening capital. It should run a controlled repair market that creates current
hypotheses, tests them in shadow, measures rejection and cost drag, and publishes receipts.

## Alternatives Considered

### Option A: Keep Shadow And Wait For Manual Research

Pros:

- Safest capital posture.
- Avoids new runtime surfaces.
- Lets humans inspect candidate strategy ideas before automation.

Cons:

- Does not create a repeatable path out of shadow.
- Leaves Jangar without repair lots to budget.
- Does not retire stale data or execution-correlation debt.

Decision: reject as the operating model. Manual review remains an override, not the main path.

### Option B: Refresh Empirical Jobs And Wire Scoped Quant Health First

Pros:

- Directly addresses visible blockers.
- Can be validated through existing endpoints.
- Likely improves `/trading/health` quickly.

Cons:

- Still leaves `strategy_hypotheses` empty.
- Does not prove positive edge after rejection drag and costs.
- Does not decide which repair is highest leverage.

Decision: require this as part of repair, not as the complete architecture.

### Option C: Hypothesis Rehydration And Proof-Gap Auction

Torghut consumes Jangar proof-gap lots, rehydrates hypothesis records, runs shadow micro-sessions, and publishes capital
receipts only when proof gaps close.

Pros:

- Converts blocked capital into measurable repair work.
- Rebuilds a durable hypothesis inventory.
- Prices rejection, cost, quant, market-context, empirical, and execution-correlation debt before capital.
- Gives Jangar compact receipts instead of broad database semantics.
- Creates a six-month path for profitability work rather than another one-off gate.

Cons:

- Requires a new projection route and receipt vocabulary.
- Requires discipline to prevent overfitting during micro-sessions.
- Requires repair capacity management so proof lots do not become an unbounded queue.

Decision: select Option C.

## Architecture

### TorghutProofGapLot

Torghut mirrors Jangar lots with Torghut-specific evidence:

```text
torghut_proof_gap_lot
  lot_id
  generated_at
  fresh_until
  gap_class
  hypothesis_id
  account
  window
  current_evidence_ref
  missing_evidence_ref
  repair_plan
  validation_gate
  capital_impact
  decision
```

Initial gap classes:

- `hypothesis_inventory_empty`
- `research_chain_skipped`
- `empirical_authority_stale`
- `quant_stage_missing`
- `market_context_stale`
- `rejection_drag_unretired`
- `execution_correlation_absent`
- `paper_settlement_missing`

### HypothesisRehydrationCandidate

Torghut creates a candidate only when a lot can name the source research and target proof:

```text
hypothesis_rehydration_candidate
  candidate_id
  lot_id
  hypothesis_id
  strategy_family
  symbols
  account
  window
  source_research_refs
  required_features
  expected_edge_bps
  max_reject_rate
  max_drawdown_bps
  validation_protocol
```

No candidate can become paper-capital eligible until it has a shadow micro-session receipt.

### ShadowMicroSession

Shadow sessions run zero-notional or simulator-backed decisions to settle proof:

```text
shadow_micro_session
  session_id
  candidate_id
  started_at
  completed_at
  decisions_attempted
  decisions_rejected
  quote_quality_pass_rate
  expected_net_edge_bps
  realized_or_replayed_net_edge_bps
  max_drawdown_bps
  quant_stage_digest
  market_context_digest
  empirical_digest
  decision
```

### ProfitRehydrationReceipt

Torghut publishes one receipt back to Jangar:

```text
profit_rehydration_receipt
  receipt_id
  lot_id
  hypothesis_id
  account
  window
  generated_at
  fresh_until
  closed_gap_classes[]
  open_gap_classes[]
  shadow_session_refs[]
  rejection_attribution_ref
  tca_ref
  quant_ref
  market_context_ref
  empirical_ref
  capital_decision
  rollback_trigger
```

Capital decisions are:

- `observe_only`
- `shadow_repair_allowed`
- `paper_dry_run_allowed`
- `paper_capital_allowed`
- `live_capital_allowed`
- `blocked`

Initial rollout must emit only `observe_only`, `shadow_repair_allowed`, or `blocked`.

## Measurable Trading Hypotheses

- Rehydrating durable hypothesis rows from current research and manifests will reduce `hypothesis_inventory_empty` to
  zero before any paper-capital attempt.
- Refreshing empirical jobs will turn dependency quorum from `block` to at least `delay` or `allow` for shadow repair
  candidates.
- Scoped quant repair will populate account/window pipeline stages and reduce scoped lag below the configured budget
  before paper dry runs.
- Market-context repair will move active-symbol domains from `stale` to fresh for the target hypothesis symbols.
- Rejection attribution will classify 100 percent of new rejected shadow decisions into data, policy, market-context,
  sizing, broker, or strategy categories.
- Shadow micro-sessions will show positive expected net edge after fees, slippage, rejection drag, and drawdown before
  paper capital is considered.

## Capital Guardrails

Paper capital remains blocked unless all are true:

- `strategy_hypotheses` contains a current row for the target hypothesis.
- The candidate has a current research chain that is not skipped-only.
- Required empirical jobs are fresh, truthful, and promotion-authority eligible.
- Scoped Jangar quant health is fresh for the exact account/window and includes non-empty pipeline stages.
- Market-context domains required by the strategy are fresh.
- New rejection attribution is complete and within budget.
- Execution correlation is present for new executions or explicitly not applicable in zero-notional shadow mode.
- Kill switch and simple submission toggles remain conservative until paper dry-run receipts pass.

Live capital additionally requires:

- multiple positive paper-capital receipts across the agreed session count;
- positive net edge after costs and rejection drag;
- no open capital-critical proof-gap lots;
- explicit live submission enablement;
- rollback drill evidence from the deployer stage.

## Engineer Acceptance Gates

- Add a Torghut proof-gap projection route that emits lots for empty hypothesis inventory, skipped research, stale
  empirical authority, empty scoped quant stages, stale market context, rejection drag, missing execution correlation,
  and missing paper settlement.
- Add tests proving empty `strategy_hypotheses` and skipped-only `research_runs` block all paper/live capital receipts.
- Add tests proving scoped quant health without pipeline stages creates `quant_stage_missing`.
- Add tests proving stale market context creates a market-context lot scoped to active symbols.
- Add tests proving new shadow decisions must have typed rejection attribution before a receipt can pass.
- Add tests proving `simple_submit_disabled` and kill-switch state still block paper/live capital even if all proof lots
  close.
- Add fixture receipts for `observe_only`, `shadow_repair_allowed`, `paper_dry_run_allowed`, and `blocked`.

## Deployer Acceptance Gates

- Publish proof-gap lots in shadow for one market session.
- Confirm the live system emits the current expected lots: hypothesis inventory empty, research skipped, empirical
  stale, quant stage missing, market context stale, rejection drag, and execution correlation absent.
- Run one bounded rehydration candidate in shadow mode only. It must not submit broker orders.
- Do not enable paper dry runs until the candidate has fresh quant stages, fresh market context, and complete rejection
  attribution.
- Do not enable paper capital until paper dry-run receipts are positive and all capital-critical lots are closed.
- Do not enable live capital until paper settlement is positive across multiple sessions and rollback drills pass.

## Rollout Plan

1. **Shadow lots:** expose lots and receipts without changing submission behavior.
2. **Repair candidates:** allow one shadow rehydration candidate per gap class.
3. **Shadow micro-sessions:** run zero-notional sessions and emit receipts.
4. **Paper dry-run gate:** allow simulator or broker-paper dry runs only when proof lots close for the target scope.
5. **Paper capital gate:** allow paper capital only with positive receipts and explicit toggles.
6. **Live gate:** keep live blocked until paper settlement, rollback drills, and live toggles are all green.

## Rollback Plan

- Disable proof-gap lot enforcement and return to the existing submission council and profit-proof exchange.
- Mark all outstanding rehydration receipts expired.
- Keep live submission disabled.
- Reopen only shadow repair after route health, schema health, and Jangar runtime-kit health are confirmed.
- Preserve failed lot and receipt payloads for post-incident review.

## Risks

- Rehydration can overfit if candidate generation is not tied to out-of-sample or sequential validation.
- Fresh options and quant data can be mistaken for profit proof if receipts do not price rejection and cost drag.
- Missing execution correlation weakens historical TCA; new sessions must enforce correlation from the start.
- Stale market context can keep promising hypotheses in repair for longer than expected.
- A proof-gap queue can grow faster than repair capacity; deployment must cap concurrent lots.

## Handoff Contract

Engineer stage owns proof-gap projection, candidate generation, shadow micro-session receipt shape, and tests that keep
capital blocked while proof is missing. Deployer stage owns shadow publication, repair concurrency caps, paper dry-run
cutover, paper-capital cutover, live-capital cutover, and rollback drills. The first acceptance target is not live
trading; it is one current hypothesis with closed proof gaps, fresh scoped evidence, complete rejection attribution, and
a positive shadow receipt.
