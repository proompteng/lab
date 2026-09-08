# 151. Torghut Repair Alpha Carry Exchange And Paper Settlement Ledger (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Decision

I am selecting **a repair alpha carry exchange with a paper settlement ledger** for Torghut.

Torghut now exposes the right raw facts. Live `/readyz` reported Postgres, ClickHouse, Alpaca, universe, database
schema, and empirical jobs as available, but the service remained `degraded` because the profitability proof floor was
`repair_only`, `capital_state=zero_notional`, and `max_notional=0`. The live proof floor named four blockers:
`hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`, and
`simple_submit_disabled`.

That is correct capital behavior. The system should not trade live while alpha readiness is missing, execution quality
is far outside guardrail, market context is stale, and live submit is disabled. The gap is that the repair ladder is
not yet a measurable exchange. It lists actions and expected unblock value, but it does not define how to rank repair
carry, what evidence closes a paper gate, or how deployers distinguish a useful zero-notional repair from activity.

The selected design turns each repair candidate into a measurable hypothesis with a carry estimate, guardrail, closure
test, and paper settlement receipt. Jangar admits the work through repair settlement cells; Torghut measures whether
the repair increased capital option value without spending live capital.

The tradeoff is more discipline before paper. I accept that tradeoff because Torghut's live TCA evidence is not close
to acceptable: `13775` orders, `13571` filled executions, average absolute slippage
`568.6138848199565249` bps against an `8` bps guardrail, and last computation at
`2026-04-02T20:59:45.136640Z`. A system that widens capital before measuring repair carry will lose money faster than
it learns.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `repair_alpha_carry_exchange` with one candidate row per proof-floor repair code.
- Each row has `repair_code`, `dimension`, `account_label`, `source_epoch_id`, `expected_unblock_value`,
  `estimated_repair_carry`, `evidence_cost`, `risk_tier`, `closure_test`, `guardrails`, and `jangar_warrant_ref`.
- The exchange ranks repair work by expected capital option value after evidence cost, not by cron recency.
- Repairs remain `max_notional=0` until a paper settlement ledger entry closes.
- Paper settlement ledger entries record hypothesis id, replay window, paper window, TCA delta, fillability delta,
  market-context freshness, quant pipeline freshness, and rollback triggers.
- Paper canary can only open when the relevant repair candidate has a closed Jangar repair cell and a passing Torghut
  paper settlement entry.
- Live micro canary remains blocked until paper settlement is complete, live submit quorum is healthy, and expected
  shortfall coverage is defined.
- Live scale remains blocked until live micro settlement exists and drawdown/shortfall guardrails are active.

## Evidence Snapshot

All evidence was collected read-only. I did not change trading mode, submit flags, database records, ClickHouse data,
Kubernetes resources, GitOps manifests, or empirical artifacts.

### Live Service Evidence

- Active live revision was `torghut-00259-deployment` `1/1`.
- Live `/readyz` returned `status=degraded`.
- Postgres, ClickHouse, Alpaca, database schema, universe, empirical jobs, and DSPy runtime checks were non-blocking or
  healthy.
- Alpaca endpoint class was `live`, account label `PA3SX7FYNUTF`, account status `ACTIVE`.
- Live submission gate was not ok: `simple_submit_disabled`, capital stage `shadow`.
- Profitability proof floor was required and not ok: `repair_only`, `capital_state=zero_notional`.
- Quant evidence was informational but degraded for the `15m` window.
- Live proof-floor blockers were:
  - `hypothesis_not_promotion_eligible`
  - `execution_tca_slippage_guardrail_exceeded`
  - `market_context_stale`
  - `simple_submit_disabled`
- Live proof-floor repair ladder ranked:
  - `live_submit_gate_closed`, priority `80`, expected unblock value `1`
  - `repair_alpha_readiness`, priority `70`, expected unblock value `4`
  - `repair_execution_tca`, priority `65`, expected unblock value `3`
  - `repair_market_context`, priority `55`, expected unblock value `1`
  - `repair_drift_governance`, priority `40`, expected unblock value `1`
  - `closed_session_signal_hold`, priority `15`, expected unblock value `3`

### Simulation Service Evidence

- Active simulation revision was `torghut-sim-00359-deployment` `1/1`.
- Simulation `/readyz` returned `status=ok`.
- Simulation proof floor was still `repair_only`, `capital_state=zero_notional`, `max_notional=0`.
- Simulation blockers were alpha readiness, execution TCA guardrail, and market context.
- Simulation execution TCA had average absolute slippage `17.4301320928571429` bps against an `8` bps guardrail, with
  `3` unsettled executions and latest execution created at `2026-05-07T09:20:28.484857Z`.
- Simulation quant latest metrics were empty and pipeline stage rows were missing, but quant evidence was not required
  in non-live mode.

### Database And Data Evidence

- Torghut live `/db-check` returned `ok=true`.
- Current and expected Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- Schema graph roots were `0001_initial`; branch count was `1`; duplicate revisions and orphan parents were empty.
- Lineage was ready but warned about historic parent forks:
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Account-scope checks were marked ready, with a warning that account scope is bypassed when multi-account trading is
  disabled.
- Direct database exec was RBAC-blocked for the Jangar worker service account, so the durable evidence surface must be
  the typed readiness and db-check projections.

### Source Evidence

- `services/torghut/app/trading/revenue_repair.py` already maps proof-floor blockers into repair codes, dimensions,
  actions, priorities, and expected unblock values.
- `services/torghut/app/trading/proof_floor.py` emits proof dimensions and repair ladders, but it does not own Jangar
  control-plane admission.
- `services/torghut/app/main.py` is `4145` lines and should not absorb the exchange logic. New repair exchange code
  should live in focused trading modules.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` maps paper and live capital decisions onto
  Torghut capital clocks, but it correctly keeps stricter SLO budget decisions when capital evidence is negative.

## Problem

Torghut can say why live capital is closed, but it cannot yet prove which repair generates the most capital option
value per unit of evidence cost.

The failure modes are:

1. Repair ranking uses static priority and expected unblock value, not measured carry after evidence cost.
2. A repair can close locally without producing a paper settlement receipt that Jangar can consume.
3. Market-context and quant freshness can look like generic blockers instead of priced hypotheses.
4. Execution TCA can be stale and far outside guardrail, but the system has no paper ledger entry that says whether
   the fix improved fillability or only changed accounting.
5. Live submit can stay disabled for the right reason, but deployers still need a precise path from zero-notional
   repair to paper canary.

## Alternatives Considered

### Option A: Keep The Existing Repair Ladder

Pros:

- Already implemented.
- Simple to inspect.
- Good enough for manual prioritization.

Cons:

- Does not measure repair carry.
- Does not create paper settlement receipts.
- Leaves Jangar to infer closure from several status fields.

Decision: reject as the final contract. Keep it as an input.

### Option B: Promote The Highest Priority Repair Directly To Paper

Pros:

- Fast path to paper learning.
- Easy operational story.
- Uses existing priority values.

Cons:

- Treats expected unblock value as authority.
- Does not price evidence cost or execution risk.
- Dangerous while execution TCA is far outside guardrail.

Decision: reject. Expected unblock value is a bid, not permission.

### Option C: Add Repair Alpha Carry Exchange And Paper Settlement Ledger

Pros:

- Converts repair candidates into measurable hypotheses.
- Preserves zero-notional repair while still ranking work by profit option value.
- Gives Jangar a closure receipt that is stronger than a route becoming green.
- Separates live-submit enablement from paper settlement.
- Makes paper canary widening testable and reversible.

Cons:

- Requires a new ledger object and tests.
- Requires a carry model that starts conservative and gets calibrated.
- Adds one more handoff surface between Torghut and Jangar.

Decision: select Option C.

## Architecture

### Repair Alpha Carry Exchange

The exchange consumes proof-floor repair ladder rows and expands them into measurable repair hypotheses.

```text
repair_alpha_carry_candidate
  candidate_id
  source_epoch_id
  account_label
  repair_code
  dimension
  action
  reason
  priority
  expected_unblock_value
  estimated_repair_carry
  evidence_cost
  risk_tier
  max_notional
  jangar_warrant_ref
  closure_test
  guardrails[]
```

`estimated_repair_carry` starts as a deterministic score:

```text
estimated_repair_carry =
  expected_unblock_value
  * capital_stage_multiplier
  * freshness_multiplier
  * execution_quality_multiplier
  - evidence_cost
```

Initial multipliers:

- `capital_stage_multiplier`: `1.0` for paper blockers, `0.6` for live-only blockers, `0.2` for informational debt.
- `freshness_multiplier`: `1.0` when data is inside threshold, `0.5` when stale but recoverable, `0.1` when missing.
- `execution_quality_multiplier`: `1.0` when TCA is inside guardrail, `0.3` when above guardrail, `0.1` when stale.
- `evidence_cost`: deterministic cost based on expected runtime, required data sources, and replay size.

This model is intentionally conservative. It ranks repair work; it does not authorize capital.

### Paper Settlement Ledger

Paper settlement ledger entries are produced after a repair candidate closes and paper replay or canary evidence is
available.

```text
paper_settlement_entry
  settlement_id
  candidate_id
  jangar_warrant_ref
  account_label
  paper_window_start
  paper_window_end
  replay_window_ref
  tca_before_ref
  tca_after_ref
  avg_abs_slippage_bps_before
  avg_abs_slippage_bps_after
  fillability_delta
  market_context_freshness_seconds
  quant_stage_lag_seconds
  promotion_eligible_total
  rollback_required_total
  decision
  reason_codes[]
  rollback_target
```

Required pass conditions:

- `avg_abs_slippage_bps_after <= 8` or an explicitly approved account-specific guardrail.
- `avg_abs_slippage_bps_after < avg_abs_slippage_bps_before`.
- `promotion_eligible_total >= 1`.
- `rollback_required_total = 0`.
- Market context is fresh enough for the current session class.
- Quant stage lag is below the Jangar witness threshold for the account.
- Live submit remains disabled until paper settlement passes.

### Capital Guardrails

Repair work:

- `max_notional=0`.
- Jangar repair cell required.
- No live submit changes.

Paper canary:

- Requires closed Jangar repair cell.
- Requires passing paper settlement entry.
- Uses bounded paper notional only; live notional remains `0`.

Live micro:

- Requires passing paper settlement from a prior clean epoch.
- Requires live submit quorum.
- Requires expected shortfall guardrail and rollback trigger.

Live scale:

- Requires live micro settlement.
- Requires drawdown, shortfall, and slippage guardrails to be active.

## Implementation Scope

Engineer scope:

- Add a focused Torghut module for repair carry scoring; do not add the exchange to `main.py`.
- Extend the existing revenue repair digest with carry fields while preserving the current repair ladder shape for
  compatibility.
- Add a paper settlement ledger model or projection with compact rows and evidence refs.
- Expose the exchange and ledger through readiness/status payloads so Jangar can consume them as typed witnesses.
- Keep live submit disabled until the proof floor and paper settlement ledger both pass.

Tests:

- Static repair ladder rows are converted into carry candidates with deterministic score ordering.
- Execution TCA above guardrail lowers repair carry and blocks paper settlement.
- Market-context stale evidence creates a repair candidate but cannot close paper.
- A closed repair candidate without Jangar warrant ref cannot create a passing settlement entry.
- A passing paper settlement entry requires TCA improvement, promotion eligibility, fresh market context, and bounded
  quant lag.
- Live submit remains disabled when the proof floor is `repair_only`.

## Validation Gates

Local validation before merge:

- `python services/torghut/app/trading/revenue_repair.py --help` if the module is touched.
- `pytest services/torghut/tests/test_*repair* -q` when repair exchange code is added.
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Architecture validation for this document-only PR:

- Documentation must define the repair hypotheses, closure gates, rollout, rollback, and Jangar handoff.
- Jangar companion document must preserve zero-notional repair and stricter capital gates.

Engineer acceptance gates:

- Live proof-floor blockers produce deterministic carry candidates.
- Simulation proof-floor blockers produce candidates but do not authorize paper without a settlement entry.
- Paper settlement fails when TCA remains above guardrail or stale.
- Paper settlement fails when market context is stale.
- Paper settlement fails when promotion eligibility is zero.
- Jangar can reference the settlement entry by id and evidence refs.

Deployer acceptance gates:

- `/readyz` can remain degraded for live capital while the exchange is healthy.
- `/trading/status` or equivalent status route shows repair carry candidates and latest paper settlement entries.
- Live `submit_enabled` remains false until paper settlement and proof floor pass.
- Jangar material-action verdicts continue to hold or block paper/live capital when settlement is missing.

## Rollout

Phase 0: Shadow exchange.

- Emit repair carry candidates alongside the existing repair ladder.
- Do not change paper or live behavior.
- Compare ranking with manual repair priorities.

Phase 1: Paper settlement ledger in observe mode.

- Write settlement entries for replay and paper windows.
- Keep paper canary closed until Jangar consumes the ledger.

Phase 2: Jangar-gated paper canary.

- Allow Jangar to treat a passing settlement entry as necessary evidence for paper widening.
- Keep live notional at zero.

Phase 3: Live micro preparation.

- Define live submit quorum, expected shortfall coverage, and rollback triggers.
- Do not enable live micro until paper settlement is stable across at least one clean market session.

## Rollback

- Stop emitting carry candidates and continue exposing the existing repair ladder.
- Ignore paper settlement entries in Jangar material-action decisions.
- Keep live submit disabled.
- Keep max notional at zero for all repair work.
- If settlement persistence shipped, leave rows for audit and stop writing new entries.

## Risks

- Carry scoring can overfit stale data. Mitigation: start deterministic, conservative, and evidence-cost adjusted.
- Paper settlement could be mistaken for live approval. Mitigation: paper settlement is necessary for paper only; live
  requires separate submit quorum and shortfall gates.
- Execution TCA improvement may come from sample selection rather than better execution. Mitigation: require replay
  window refs and compare before/after windows with fillability delta.
- Market-context freshness can become an expensive blocker. Mitigation: keep freshness thresholds session-class aware
  and expose evidence cost in the exchange.

## Handoff To Engineer

Start with the exchange as a pure function around the existing repair ladder and readiness payloads. Do not modify live
submit behavior in the first patch. The first useful implementation proves deterministic candidate ranking and paper
settlement failure while TCA, market context, or alpha readiness remains bad.

Keep scoring code outside `services/torghut/app/main.py`. Use small fixtures from the live and simulation evidence in
this document so regression tests cover the current failure modes.

## Handoff To Deployer

Do not treat a carry candidate as permission to trade. It is a ranked repair hypothesis. The only deployer action it
can unlock is bounded zero-notional repair through a Jangar repair settlement cell.

Paper canary remains closed until:

- The candidate has a closed Jangar repair cell.
- The paper settlement ledger entry passes.
- TCA is inside guardrail or explicitly waived.
- Market context is fresh.
- Alpha readiness has at least one promotion-eligible candidate and zero rollback-required candidates.

Live remains closed until paper settlement, live submit quorum, expected shortfall coverage, and rollback triggers are
all current.
