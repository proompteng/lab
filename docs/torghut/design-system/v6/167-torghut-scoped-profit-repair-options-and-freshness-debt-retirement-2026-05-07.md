# 167. Torghut Scoped Profit Repair Options And Freshness Debt Retirement (2026-05-07)

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

I am selecting **scoped profit repair options with freshness debt retirement** as Torghut's companion architecture for
the Jangar scoped evidence debt ledger.

Torghut is operationally available but not profit-ready. Live `/readyz` reports Postgres, ClickHouse, schema, universe,
and readiness cache healthy. The same payload also reports service status `degraded`, live submit disabled, proof floor
`repair_only`, capital state `zero_notional`, zero routeable live symbols, stale market context, stale empirical jobs,
and zero promotion-eligible hypotheses. Jangar unscoped quant health can report OK with hundreds of latest metrics, but
scoped paper quant health for an account/window can still be empty and stage-less. That means Torghut needs to rank
repairs by the scoped debt they retire, not by broad service health.

The selected architecture introduces a **ScopedProfitRepairOptionBook**. Each option is a zero-notional repair bet
against one scoped debt item: quant scope, market-context freshness, empirical job freshness, route/TCA proof,
hypothesis readiness, or submission proof floor. An option is not capital. It is permission to spend bounded compute
and data-plane capacity to produce a **FreshnessDebtRetirementReceipt**. Jangar consumes that receipt through the
ScopedEvidenceDebtLedger before any paper or live action changes state.

The tradeoff is that Torghut will keep potentially attractive route ideas in repair-only mode until scoped freshness is
current. I accept that tradeoff because profitability work without scoped freshness is not a hypothesis test. It is
artifact generation.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources, database records, GitOps
resources, AgentRuns, broker state, Torghut flags, or ClickHouse tables.

### Runtime And Cluster Evidence

- Torghut live `torghut-00280-deployment` and sim `torghut-sim-00380-deployment` were both available on image digest
  `sha256:0927f669a37ccc4130ab7693a5ea91b446f4bc0cfb7709613fa49e00b8b95a4b`.
- Torghut options catalog, options enricher, TA, TA sim, ClickHouse, Keeper, WebSocket, and guardrail exporters were
  running.
- Recent Torghut events showed successful database migration, empirical-jobs backfill, whitepaper bootstrap, and
  semantic backfill on the latest revision. They also showed transient startup/readiness failures during revision
  handoff and one retained whitepaper autoresearch pod in `Error`.
- Agents namespace still carried retained failures: 38 failed pods and 15 failed-only jobs. A market-context provider
  pod failed after `codex-implement` timed out at 600 seconds, then hit a runner bug when writing byte output as text.
- Direct `psql`, ClickHouse `exec`, and secret listing were forbidden to this worker. Torghut must assume typed routes
  and exporters are the normal proof surfaces for least-privilege operators.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, one branch, and lineage-ready graph.
- The schema graph still warns about parent forks at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Account-scope checks were marked ready only because multi-account trading is disabled; the route returned an explicit
  bypass warning.
- ClickHouse guardrails reported both replicas reachable, no read-only replicated tables, disk free ratios around
  `0.968` and `0.964`, and TA signal/microbar timestamps around `2026-05-07T20:21:28Z`.
- Market-context health was degraded: technicals and regime were about 812 seconds old, fundamentals about 4,862,536
  seconds old, and news about 9,754 seconds old.
- Jangar unscoped quant health for `15m` was OK with 612 latest metrics and about 5 seconds lag, but account/window
  scoping was omitted.
- Jangar scoped paper quant health for `paper/1m` was degraded with zero latest metrics, an empty latest-store alarm,
  no stages, and account/window scope enforced.

### Profitability Evidence

- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Live proof-floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live routeability was zero of eight scoped symbols. `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA` were blocked by TCA
  route evidence. `AMZN`, `GOOGL`, and `ORCL` were missing.
- Live TCA had 7334 orders and 7245 filled executions. Average absolute slippage was about `13.82` bps against an
  8 bps guardrail. Symbol examples: `AAPL=9.25`, `NVDA=13.48`, `AMD=14.93`, `INTC=20.57`, and `AVGO=21.86` bps.
- Live alpha readiness had three shadow hypotheses, zero promotion eligible, and three rollback required.
- Empirical jobs were completed but stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` were created at `2026-05-06T16:27:32Z` and marked stale by the current authority window.
- LLM guardrails were safe but noncontributory: LLM reviews were disabled, effective shadow mode was true, fail mode
  was strict veto, and mandatory governance evidence was incomplete.

## Problem

Torghut has enough proof to avoid unsafe capital. It does not yet have the scoped repair economics needed to become
profitable.

The current proof floor already says the correct thing: no live submit, no paper canary, no live micro, no scale. The
missing layer is a ranked repair option book that can answer:

- Which scoped debt item would this repair retire?
- Which hypothesis and symbol set benefits?
- What before receipt proves the debt exists?
- What after receipt must be produced?
- What is the expected unlock value?
- Which Jangar ledger id will consume the receipt?
- What capital surface remains forbidden while the repair runs?

Without this, Torghut can rerun empirical jobs, refill market context, recompute TCA, or refresh quant stores, but the
system cannot compare their after-cost value. Profitability improves when repair work is priced by the proof debt it
retires.

## Alternatives Considered

### Option A: Refresh Every Stale Surface Immediately

Run empirical jobs, market context, quant materialization, TCA settlement, and route probes as a broad repair wave.

Pros:

- Maximizes the chance that a later readiness check turns green.
- Simple to operate.
- Directly targets visible blockers.

Cons:

- Does not rank repairs by expected profit unlock.
- Can spend compute on low-value surfaces before routeability or hypothesis gates can consume them.
- Does not create a durable before/after receipt for Jangar.

Decision: reject as the architecture. Use it only when the option book ranks a broad refresh as the best repair.

### Option B: Promote The Best Simulation Or Live Symbol Into Paper Probe

Use the existing route book to pick the least-bad symbol and run a paper rehearsal.

Pros:

- Gets market feedback faster.
- Forces end-to-end execution paths to prove themselves.
- Might expose route problems quickly.

Cons:

- Live routeability is zero of eight symbols.
- Scoped quant and market-context debt are open.
- Paper rehearsal would look like profit exploration while proof floor is still repair-only.

Decision: reject until scoped debt retirement receipts clear the paper gate.

### Option C: Scoped Profit Repair Options And Freshness Debt Retirement

Rank zero-notional repair options by scoped debt, expected unlock value, and required after receipt. Emit retirement
receipts that Jangar can consume before any capital state changes.

Pros:

- Makes profitability repairs measurable before notional is introduced.
- Prevents unscoped health from clearing scoped capital gates.
- Keeps route, quant, empirical, market context, and hypothesis repairs comparable.
- Works with least-privilege operation because it depends on typed routes and exporters.
- Gives engineer and deployer stages explicit acceptance gates.

Cons:

- Requires a new repair option reducer and receipt schema.
- May delay paper even when one surface looks ready.
- Needs careful handling when multi-account checks are bypassed.

Decision: select Option C.

## Architecture

### ScopedProfitRepairOptionBook

Torghut publishes one option book per account label, trading mode, proof window, and Jangar ledger id.

Required fields:

```text
scoped_profit_repair_option_book
  schema_version
  option_book_id
  jangar_scoped_evidence_debt_ledger_id
  account_label
  trading_mode
  proof_window
  torghut_revision
  generated_at
  fresh_until
  options
  blocked_capital_surfaces
  selected_zero_notional_repairs
```

Each option includes:

```text
repair_option
  option_id
  debt_class
  target_hypothesis_ids
  target_symbols
  before_refs
  required_after_refs
  expected_unlock_value
  max_runtime_seconds
  max_parallelism
  max_notional
  falsification_checks
  rollback_trigger
```

`max_notional` must be `0` for every option in this design.

### FreshnessDebtRetirementReceipt

A repair only counts after Torghut emits a receipt:

```text
freshness_debt_retirement_receipt
  receipt_id
  option_id
  debt_class
  started_at
  completed_at
  before_refs
  after_refs
  retirement_state
  measured_delta
  remaining_blockers
  jangar_ledger_id
  capital_effect
```

Retirement states:

- `retired`: scoped debt cleared and after receipt is fresh.
- `reduced`: measured improvement occurred but the gate remains held.
- `unchanged`: repair ran and did not improve the scoped debt.
- `contradicted`: after receipt conflicts with another proof source.
- `failed`: repair did not produce a usable after receipt.

### Initial Option Classes

- `quant_scope_refill`: refill scoped latest metrics and stage receipts for the target account/window.
- `market_context_refresh`: refresh technicals, regime, fundamentals, and news domains with citation quality.
- `empirical_job_refresh`: rerun stale empirical jobs against the current candidate and dataset snapshot.
- `route_tca_recompute`: recompute TCA and routeability for scoped symbols.
- `missing_symbol_probe`: create zero-notional simulation probes for symbols missing TCA evidence.
- `hypothesis_gate_recheck`: recompute alpha readiness after upstream proof repairs.
- `submission_floor_recheck`: recompute proof floor after scoped debts retire.

### Profit Hypotheses

The first option book should keep the current hypothesis registry but bind each hypothesis to scoped debt:

- `H-CONT-01` can only consume `quant_scope_refill`, `route_tca_recompute`, and `empirical_job_refresh` receipts.
- `H-MICRO-01` requires fresh quant scope, route/TCA proof, and feature/drift evidence before paper.
- `H-REV-01` requires market-context retirement plus route/TCA proof before paper.

No hypothesis can move out of shadow until Jangar reports the matching scoped debt retired.

## Validation Gates

Engineer gates:

- Add pure Torghut reducers for option-book generation and retirement receipts under `services/torghut/app/trading/`.
- Do not expand `services/torghut/app/main.py` into a policy engine; routes should assemble reducer output only.
- Unit tests must cover unscoped quant OK but scoped quant empty, stale market-context domains, stale empirical jobs,
  zero routeable live symbols, missing symbol probes, TCA slippage above guardrail, and account-scope bypass warnings.
- Tests must prove every option has `max_notional=0`, at least one before ref, at least one required after ref, and a
  rollback trigger.
- Tests must prove a failed repair emits `failed` or `unchanged`, not `retired`.

Deployer gates:

- Before enabling any repair option, capture `/readyz`, `/db-check`, `/trading/autonomy`, market-context health, Jangar
  scoped quant health, ClickHouse guardrails, and Jangar scoped evidence debt.
- Enable only zero-notional repairs selected by the option book.
- Paper remains held until at least two live symbols are routeable, market context is fresh, empirical jobs are current,
  scoped quant metrics are nonempty with stages present, alpha readiness has at least one promotion-eligible hypothesis,
  and Jangar paper canary action is allowed.
- Live remains blocked until paper receipts close and Jangar live action receipts are current.

## Rollout

1. Ship option book and retirement receipts in shadow/status-only mode.
2. Compare option ranking against the existing proof-floor repair ladder for one full market session.
3. Allow the scheduler to consume selected zero-notional repair options with finite runtime and parallelism.
4. Feed retirement receipts back to Jangar scoped evidence debt and require ledger agreement before paper canary.

## Rollback

- Hide the option book from scheduler consumers.
- Continue using the existing proof floor, route reacquisition book, empirical jobs status, and Jangar material-action
  receipts.
- Keep `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`, live submit disabled, and max notional zero.
- Treat any in-flight repair without a retirement receipt as `failed` for the next option book.

## Risks

- Expected unlock value can become a vanity metric. Mitigation: calculate it from closed Jangar debt classes and proof
  floor blocker count, not from generated artifacts.
- Freshness repairs can thrash during closed market hours. Mitigation: options must include market-session context and
  expected closed-session staleness.
- Account-scope bypass can hide future multi-account debt. Mitigation: encode bypass as debt for paper/live promotion
  even when it is informational for readiness.
- Route probes can overfit one symbol. Mitigation: paper gate requires at least two routeable symbols and no unsettled
  execution debt.

## Handoff

Engineer: implement the option book and retirement receipts as pure reducers with tests, keep every repair at zero
notional, and wire the output into existing Torghut status routes without moving admission logic into `main.py`.

Deployer: use the option book to pick bounded zero-notional repairs only. Do not treat broad service health, unscoped
quant health, or a single successful refresh as paper or live authority; Jangar scoped debt retirement is the gate.

## 2026-05-07 21:10Z Evidence Refresh

This refresh does not change the selected Torghut direction. It updates the before-state that engineers and deployers
must use when implementing the option book.

Read-only runtime evidence showed:

- The live `torghut-00283` and simulation `torghut-sim-00383` revisions were running at `2/2` after a fresh migration
  job and revision handoff.
- `/healthz` returned `status=ok`, but `/readyz` returned HTTP `503` with service `status=degraded`.
- `/db-check` was current on Alembic head `0029_whitepaper_embedding_dimension_4096`, with one branch, no missing or
  unexpected heads, no duplicate revisions, no orphan parents, and lineage-ready graph.
- Schema warnings remained active for parent forks at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; account-scope checks were considered ready only because multi-account trading is
  disabled.
- `/readyz` reported Postgres, ClickHouse, Alpaca, database schema, universe, readiness cache, and scheduler checks
  healthy.
- The same `/readyz` proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max
  notional `0`.
- Live submission was not allowed because `simple_submit_disabled`; configured live promotion and autonomy promotion
  were not eligible.
- Alpha readiness had `3` hypotheses, `0` promotion eligible, and `3` rollback required; dependency quorum decision was
  `block` because empirical jobs were degraded.
- Proof-floor blockers included `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_incomplete`, `market_context_stale`, and `simple_submit_disabled`.
- Market-context health for `NVDA` was degraded through Jangar: technicals and regime were stale at about `922s`, news
  at about `12363s`, and fundamentals at about `4865116s`.
- Route reacquisition showed no capital-routeable universe: `AAPL` was only `probing`, `AMD`, `AVGO`, `INTC`, and
  `NVDA` were blocked by route evidence, and `AMZN`, `GOOGL`, and `ORCL` were missing.
- The route book ranked repair candidates with `NVDA` first, then `AMD`, `INTC`, `AVGO`, `AMZN`, `GOOGL`, and `ORCL`;
  every candidate retained `paper_probe_notional_limit=0`.
- Quant evidence remained informational rather than capital-authoritative: `quant_pipeline_stages_missing` with latest
  metrics present, no stage receipts, and no permission to clear paper or live gates.

The implementation priority is therefore:

1. Emit a scoped option book whose first ranked repair is still zero-notional route/TCA repair, not paper rehearsal.
2. Require market-context and empirical-job retirement receipts before `AAPL` can move from probing evidence to a paper
   candidate.
3. Treat account-scope bypass as a paper/live debt even though it is informational for readiness while multi-account
   trading is disabled.
4. Require Jangar scoped evidence debt agreement before any option changes capital state.

Deployer must keep live submit disabled and max notional zero through this refresh. The only allowed operational use of
the option book is to schedule bounded proof repair work that emits before/after receipts.
