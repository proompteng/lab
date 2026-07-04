# 204. Torghut Alpha Repair Dividend Ledger And Custody Flight Recorder (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut alpha readiness repair, routeable candidate dividend accounting, zero-notional guardrails,
consumer-evidence carry, Jangar material action custody, validation, rollout, rollback, and business handoff.

Companion Jangar contract:

- `docs/agents/designs/199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`

Extends:

- `203-torghut-alpha-closure-dividend-slo-and-consumer-evidence-carry-2026-05-14.md`
- `202-torghut-compact-alpha-closure-export-and-no-delta-lease-2026-05-14.md`
- `201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`
- `200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md`
- `198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`

## Decision

I am selecting an **alpha repair dividend ledger with Jangar custody flight-recorder carry** as the next Torghut
architecture increment.

The evidence says Torghut has the right business target but not enough cross-plane finality. On 2026-05-14,
`GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned `business_state=repair_only`,
`revenue_ready=false`, and top queue item `repair_alpha_readiness`. The selected value gate was
`routeable_candidate_count`, the required output was `torghut.executable-alpha-receipts.v1`, and capital remained
zero notional. Routeability accepted `0` candidates and reported `zero_notional_or_stale_evidence_rate=1.0`.

The top repair is measurable. Torghut had `3` executable alpha receipts, all zero notional, with
`paper_replay_candidate_count=0` and `capital_ready=false`. The blocked hypotheses were `H-CONT-01`, `H-MICRO-01`,
and `H-REV-01`. The queue assigned `repair_alpha_readiness` priority `70` and expected unblock value `2`. The repair
bid settlement ledger compacted `42` raw bids into `6` lots, selected `5`, and marked `3` dispatchable, while the
routeable candidate count stayed zero.

Data quality is not the blocking issue. `GET /db-check` returned `ok=true`, `schema_current=true`, current and
expected Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, no
lineage errors, and no warnings. The right stance is not schema repair. It is dividend accounting: every alpha repair
attempt must say whether it moved the business value gate, preserved blockers, created no-delta debt, or is eligible
for another zero-notional repair slot.

The selected design adds `torghut.alpha-repair-dividend-ledger.v1` and carries its compact reference into Jangar's
`jangar.material-action-custody-flight-recorder.v1`. Torghut owns the trading hypothesis, evidence windows, routeable
candidate counts, and capital guardrails. Jangar owns whether a material action may launch, deploy, or merge. The
ledger is the handoff object between those ownership lines.

The tradeoff is that Torghut must produce one more stable object before Jangar can dispatch repair work. I accept
that. The business blocker is not lack of runner volume. It is repeated work that does not change
`routeable_candidate_count`. A dividend ledger makes no-delta explicit and gives the next implementer a precise target:
settle an alpha repair dividend under `max_notional=0` before any paper or live capital release.

## Governing Runtime Requirements

This contract follows the active validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value-gate mapping:

- `routeable_candidate_count`: primary dividend. A successful repair increases accepted routeable candidates from `0`
  to at least `1`, or records no-delta debt with release conditions.
- `zero_notional_or_stale_evidence_rate`: remains `1.0` until selected repair receipts are current and accepted.
- `fill_tca_or_slippage_quality`: remains a guardrail for route universe and execution quality before paper.
- `post_cost_daily_net_pnl`: remains a profitability guardrail for hypotheses with non-positive expectancy.
- `capital_gate_safety`: live submit remains disabled, capital stage remains `shadow`, and max notional remains `0`.

Jangar value-gate mapping:

- `failed_agentrun_rate`: Jangar denies repeated repair launches when the alpha dividend ledger has unchanged
  no-delta release keys.
- `pr_to_rollout_latency`: deployer handoff cites the compact dividend ledger instead of recomputing the full revenue
  repair payload.
- `ready_status_truth`: Torghut `repair_only` is carried as material hold, not serving failure.
- `manual_intervention_count`: the next action names a specific hypothesis, blocker set, receipt, and release key.
- `handoff_evidence_quality`: every repair handoff cites ledger id, selected hypothesis, before/after count,
  preserved blockers, validation command, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading
flags, broker state, GitOps resources, AgentRuns, or market data.

### Serving And Cluster Evidence

- Torghut Argo application was `Synced/Healthy` at `2ee617e354af746549731b54e037f90af5d3fd6f`.
- Active live revision `torghut-00382` and sim revision `torghut-sim-00480` were each `1/1` available.
- Torghut DB, ClickHouse shards, Keeper, TA, TA sim, options catalog, options enricher, WebSocket services, and
  guardrail exporters were running.
- Older Torghut revisions were scaled to `0/0`, while active revision `00382` used image digest
  `sha256:bdc6463153c8ede2b46648596cc3c3f83dfdb5d572a1cd86dfbb93c51fbb5236`.
- Jangar `/ready` returned serving `status=ok`, but business state stayed `repair_only` and execution trust was
  degraded on the Torghut quant dependency.

### Database And Data Quality

- `/db-check` returned `ok=true`, `schema_current=true`, current head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, no lineage errors, and
  no warnings.
- Direct CNPG listing and pod exec were forbidden to the Jangar service account. This design therefore treats the
  application database witness as the authoritative read-only evidence surface for this lane.
- The route evidence payload remained current enough to make a business decision, but it did not permit capital:
  `revenue_ready=false`, `max_notional=0`, and live submission disabled.

### Revenue Repair Evidence

- Top queue item: `repair_alpha_readiness`.
- Reason: `hypothesis_not_promotion_eligible`.
- Dimension: `alpha_readiness`.
- Action: `clear_hypothesis_blockers_before_capital`.
- Priority: `70`.
- Expected unblock value: `2`.
- Value gate: `routeable_candidate_count`.
- Required output: `torghut.executable-alpha-receipts.v1`.
- Routeability: `accepted_routeable_candidate_count=0`, aggregate state `blocked`,
  `zero_notional_or_stale_evidence_rate=1.0`.
- Repair bid settlement: `42` raw bids, `6` compacted lots, `5` selected lots, `3` dispatchable lots, and
  `routeable_candidate_count=0`.
- Executable alpha: `3` receipts, `3` zero-notional receipts, `0` paper replay candidates, `capital_ready=false`.
- Blocked hypotheses: `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`.
- Capital state: `shadow`, `zero_notional`, live submission disabled by `simple_submit_disabled`.

### Source And Test Surface

- `services/torghut/app/main.py` is `6938` lines and remains the high-risk integration surface for ready, status,
  trading, consumer evidence, and repair endpoints.
- `services/torghut/app/trading/revenue_repair.py` is `1111` lines and owns the live repair digest.
- `services/torghut/app/trading/alpha_repair_closure_board.py` is `820` lines and owns selected closure boards.
- `services/torghut/app/trading/repair_bid_settlement.py` is `716` lines and owns lot compaction.
- `services/torghut/app/trading/alpha_evidence_foundry.py` is `608` lines and owns evidence-window receipts.
- Existing tests cover revenue repair, repair-bid settlement, alpha evidence, alpha closure, and executable alpha
  receipts. The missing test family is alpha repair dividend finality: paid dividend, no-delta debt, unchanged release
  key, changed release key, stale ledger, zero-notional guardrail, and consumer-evidence/Jangar recorder parity.

## Problem

Torghut can show the repair queue, but it does not yet produce a compact, final dividend ledger that Jangar can use to
decide whether another material action should start.

The concrete failure modes are:

1. `repair_alpha_readiness` can remain top priority while multiple repair lots are dispatchable and none has changed
   `routeable_candidate_count`.
2. Jangar can see a launch-allowed repair ticket without a compact Torghut statement that the previous repair paid or
   failed to pay a dividend.
3. No-delta debt can be visible in detailed repair evidence but not carried as the release key that prevents repeated
   launches.
4. Capital safety can be correct (`max_notional=0`) while operators still lack a crisp next action.
5. H-CONT-01, H-MICRO-01, and H-REV-01 have different blockers, but current handoff can collapse them into one generic
   alpha readiness failure.
6. Deployer and verifier stages cannot prove business progress without reading the full Torghut repair payload.

The system needs a ledger that turns alpha repair attempts into dividend accounting.

## Alternatives Considered

### Option A: Keep Using `/trading/revenue-repair` As The Full Source Of Truth

Torghut would continue to expose all repair details through `/trading/revenue-repair`, and Jangar or operators would
extract the relevant result.

Advantages:

- No new schema.
- Full detail remains available.
- Existing endpoint already has business context.

Disadvantages:

- The payload is too broad for launch custody.
- No-delta release keys are not the first-class object Jangar enforces.
- Deployer handoff remains manual and error-prone.
- Jangar can still cite one dispatchable lot without carrying the overall repair-only decision.

Decision: reject as the custody boundary. Keep it as the diagnostic and source reducer surface.

### Option B: Let Jangar Infer Dividends From Consumer Evidence

Torghut would keep existing consumer evidence fields, and Jangar would infer whether alpha repair changed the value
gate.

Advantages:

- Keeps Torghut schema surface smaller.
- Lets Jangar centralize all custody decisions.
- Can be implemented without changing Torghut endpoints.

Disadvantages:

- Jangar would own trading-specific inference it should not own.
- Inference can drift when Torghut changes repair semantics.
- Hypothesis-level blockers and routeable candidate deltas belong with Torghut.
- It hides the business dividend from Torghut's own deployer and verify stages.

Decision: reject.

### Option C: Add `torghut.alpha-repair-dividend-ledger.v1`

Torghut emits a compact ledger that records selected hypotheses, repair attempts, before/after routeable candidate
counts, preserved and retired blockers, no-delta release keys, validation commands, and capital guardrails. Jangar
links the ledger from the material action custody flight recorder.

Advantages:

- Makes the business dividend explicit.
- Prevents repeated zero-delta repair launches under unchanged evidence.
- Keeps trading inference inside Torghut and action custody inside Jangar.
- Gives deployer and verifier stages a small proof object.
- Directly maps to `routeable_candidate_count`.

Disadvantages:

- Adds a schema and compatibility tests.
- Requires parity checks against `/trading/revenue-repair`.
- Can hold a useful repair if the ledger is stale while the full endpoint is fresh.

Decision: select Option C.

## Architecture

Torghut emits `torghut.alpha-repair-dividend-ledger.v1`.

```text
torghut.alpha-repair-dividend-ledger.v1
  ledger_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  account_id
  window
  trading_mode
  capital_rule
  max_notional
  selected_value_gate: routeable_candidate_count
  routeable_candidate_count_before
  routeable_candidate_count_after
  measured_delta
  dividend_state: paid | no_delta | pending | blocked | stale
  selected_hypothesis_id
  selected_strategy_id
  selected_repair_class
  required_output_receipt
  source_repair_bid_refs[]
  executable_alpha_receipt_refs[]
  preserved_reason_codes[]
  retired_reason_codes[]
  introduced_reason_codes[]
  no_delta_release_key
  no_delta_release_conditions[]
  next_allowed_attempt_after
  jangar_custody
    required_recorder_schema: jangar.material-action-custody-flight-recorder.v1
    allowed_action_class: dispatch_repair
    denied_action_classes[]
  validation_commands[]
  rollback_target
```

### Dividend Semantics

- `paid`: `routeable_candidate_count_after > routeable_candidate_count_before` and all capital guardrails remain
  satisfied.
- `no_delta`: the attempt completed, preserved blockers remain, and routeable candidate count did not increase.
- `pending`: the selected repair has an open receipt or open settlement.
- `blocked`: required inputs are missing, schema mismatched, or capital guardrails are violated.
- `stale`: `fresh_until` has expired or source evidence changed without a new ledger.

### Repair Hypotheses

The first implementation must evaluate three active hypotheses:

- `H-CONT-01`: continuation lane; blocker family `post_cost_expectancy_non_positive` plus closed-session signal/TCA
  holds.
- `H-MICRO-01`: microstructure-breakout lane; blocker family `drift_checks_missing` and feature/signal availability.
- `H-REV-01`: event-reversion lane; blocker family `post_cost_expectancy_non_positive` plus market-context, signal,
  and TCA holds.

The selected repair should optimize expected movement in `routeable_candidate_count`, not raw number of blockers
retired. A one-blocker repair that creates one routeable candidate beats a broad repair that preserves the value gate
at zero.

## Rollout Plan

Phase 0 is this architecture PR.

Phase 1 adds a pure Torghut builder for the dividend ledger from existing revenue repair, repair-bid settlement, and
executable alpha evidence. It emits in diagnostics only.

Phase 2 adds the compact ledger ref to `/trading/consumer-evidence` and validates parity with `/trading/revenue-repair`.

Phase 3 wires the ledger into Jangar's material action custody flight recorder. Jangar holds repeated repair dispatch
when the no-delta release key is unchanged.

Phase 4 promotes the ledger from shadow to enforcement only after deployer proves Argo, workload, `/ready`,
Jangar status, Torghut revenue repair, and Torghut consumer evidence are green or explicitly held.

## Validation Gates

Torghut implementation must pass:

- `uv run --frozen pytest services/torghut/tests/test_revenue_repair.py -k alpha`
- `uv run --frozen pytest services/torghut/tests/test_repair_bid_settlement.py -k promotion_custody`
- `uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window`
- a new `test_alpha_repair_dividend_ledger.py` covering paid, no-delta, stale, and changed release-key cases;
- all three Torghut Pyright profiles before claiming type-check success.

Jangar integration must pass:

- material action custody recorder tests that consume the compact ledger;
- Torghut consumer evidence tests proving schema mismatch is a hold, not an allow;
- ready/status route tests proving `/ready=ok` does not imply material action allow.

## Rollback

Rollback is capital-safe:

- stop emitting the alpha repair dividend ledger from consumer evidence;
- keep `/trading/revenue-repair` as the diagnostic source;
- keep Jangar recorder mode in `observe`;
- keep live submit disabled;
- keep `max_notional=0`;
- keep paper/live canary classes held until a later capital-release contract supersedes this design.

Emergency rollback: mark dividend state `blocked`, clear Jangar launch permission for `dispatch_repair`, and require
manual review of the full revenue repair digest before any new alpha repair AgentRun.

## Risks

- The dividend ledger could duplicate fields from revenue repair and drift if parity tests are weak.
- No-delta release keys can be too coarse, holding useful repairs after a meaningful but unmodeled evidence change.
- Per-hypothesis accounting can bias toward easy blockers instead of highest expected revenue.
- Jangar enforcement can over-hold if the ledger is stale while the full endpoint is fresh.

The mitigation is to make parity tests mandatory, keep the first implementation in shadow, encode release conditions
explicitly, and preserve the full `/trading/revenue-repair` payload as the diagnostic authority.

## Engineer Handoff

Next bounded implementation milestone: add `build_alpha_repair_dividend_ledger()` to Torghut as a pure builder and
include its compact ref in consumer evidence behind an observe-mode flag.

Acceptance gates:

- The current evidence window produces `dividend_state=no_delta` or `blocked`, not `paid`, while
  `routeable_candidate_count` remains `0`.
- The ledger carries `max_notional=0`, `capital_rule=zero_notional_repair_only`, selected value gate
  `routeable_candidate_count`, and required output `torghut.executable-alpha-receipts.v1`.
- A changed evidence window, blocker set, source ref, or required receipt set changes the no-delta release key.
- Jangar can cite the compact ledger id in `jangar.material-action-custody-flight-recorder.v1`.

## Deployer Handoff

Deployer must prove:

- Torghut Argo app is synced and healthy, or drift is recorded as a hold.
- Active live and sim revisions are available.
- `/db-check` is current at expected head.
- `/trading/revenue-repair` top queue still targets `repair_alpha_readiness` until cleared.
- `/trading/consumer-evidence` carries the dividend ledger ref with no schema mismatch.
- Jangar recorder either holds or allows dispatch based on the same ledger id.

Until the ledger is implemented, the smallest blocker preventing revenue impact is absence of compact dividend
accounting for alpha readiness repair attempts.
