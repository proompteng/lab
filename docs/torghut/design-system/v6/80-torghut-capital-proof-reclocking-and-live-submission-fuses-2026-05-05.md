# 80. Torghut Capital Proof Reclocking and Live Submission Fuses

Status: Accepted for implementation planning

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

Torghut should reclock live submission from settled profit proof, not from route liveness or a simple-lane readiness
flag. I am choosing a capital proof reclocking fuse because the current runtime says `live_submission_gate.allowed:
true`, while the hypothesis ledger says no hypothesis is promotion eligible, all three hypotheses require rollback,
Jangar dependency quorum is blocked, signal lag is over 58,000 seconds, and the empirical jobs needed for promotion
are stale from March 21.

The selected architecture makes the live submission gate consume a `CapitalProofClock` for every account/window and
hypothesis. A clock is valid only when Jangar rollout settlement allows external capital, Torghut empirical proof is
fresh, signal and market-context leases are fresh for the requested strategy family, TCA is within budget, and the
hypothesis ledger has no active rollback requirement. If that clock is not valid, Torghut may keep observing and may
run repair jobs, but it cannot report live submission as ready for non-shadow capital.

The tradeoff is that Torghut will reject or hold some simple-lane submissions that were previously allowed. That is the
right tradeoff. A live route can be operationally ready and still be economically unauthoritative.

## Runtime Evidence

All checks were read-only.

### Cluster and Control-Plane Dependency

- Jangar `/ready` is serving and leader election is healthy.
- Jangar `/api/agents/control-plane/status?namespace=agents` reports healthy controller heartbeats and healthy DB
  migration parity, but `dependency_quorum.decision: block`.
- Jangar blocks on `watch_reliability_blocked` and `empirical_jobs_degraded`.
- Jangar execution trust is degraded with five pending requirements and stale discover/plan/implement/verify clocks.
- Recent agents namespace events show registry 502 image-pull failures, `ImagePullBackOff`, readiness probe timeouts,
  and backoff-limit failures during the rollout window.

### Torghut Runtime and Profit State

- `curl http://torghut.torghut.svc.cluster.local/trading/status` returned `running: true`, `mode: live`, and
  `kill_switch_enabled: false`.
- `live_submission_gate.allowed` is `true` with reason `ready`, but `autonomy_promotion_eligible` and
  `drift_live_promotion_eligible` are both false.
- `quant_evidence.status` is `not_required`, so live submission can be allowed without a configured quant health proof.
- Hypothesis readiness is not promotable: `hypotheses_total: 3`, state totals `shadow: 2` and `blocked: 1`,
  `promotion_eligible_total: 0`, `rollback_required_total: 3`, and all capital multipliers are `0`.
- Each hypothesis includes `jangar_dependency_block` and `signal_lag_exceeded`; `H-REV-01` also includes
  `market_context_stale`, while `H-MICRO-01` includes missing feature and drift checks.
- Signal lag is `58132` seconds, market session is closed, market-context domain state is empty, and no universe
  symbols are resolved from Jangar.
- Empirical jobs are stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` all carry March 21 proof timestamps and `job_stale`.
- TCA has a large realized cost envelope: `order_count: 13775`, `avg_abs_slippage_bps: 568.6138848199565249`, and no
  expected shortfall sample coverage.

### Source and Test Surface

- `services/torghut/app/main.py` is 3978 lines and assembles readiness, trading status, live-submission gate, database
  contract, empirical jobs, hypothesis readiness, and route payloads.
- `services/torghut/app/trading/submission_council.py` is 1196 lines and already models capital stages, quant evidence,
  empirical jobs, Jangar dependency quorum, and segment summaries.
- `services/torghut/app/trading/hypotheses.py` is 732 lines and already models dependency capabilities for
  `jangar_dependency_quorum`, `signal_continuity`, `drift_governance`, `feature_coverage`,
  `market_context_freshness`, and `evidence_continuity`.
- `services/torghut/app/db.py` is 483 lines and checks schema heads, graph signatures, orphan parents, duplicate
  revisions, and account-scoped trading invariants.
- `services/torghut/tests` contains 138 Python test files, including submission council, scheduler safety, autonomy,
  hypothesis governance, quant readiness, simulation parity, and profitability evidence coverage.
- The missing regression is route parity: no test proves that `live_submission_gate.allowed` is false when every loaded
  hypothesis is shadow or blocked, Jangar dependency quorum blocks, empirical proof is stale, and rollback is required.

## Problem

Torghut currently has separate clocks for live route readiness, simple-lane submission, hypothesis readiness,
empirical proof, Jangar dependency quorum, signal continuity, market context, and TCA. Those clocks can diverge.

The current runtime is a concrete example. The trading route is alive and the simple lane reports ready, but the
economic authority for non-shadow capital is not ready. This creates a false-positive capital surface: operators and
automations can see a ready live gate while every profit hypothesis says hold or rollback.

Profitability improves when capital is scarce, proof-bound, and reversible. It degrades when liveness is treated as
edge.

## Options Considered

### Option A: Keep Simple Lane Independent

Leave `live_submission_gate.allowed` as an operational lane and rely on hypothesis readiness only for autonomous
promotion.

Pros:

- Preserves current behavior.
- Avoids coupling simple submissions to the hypothesis ledger.
- Useful for emergency manual testing.

Cons:

- Creates two capital authorities with different proof standards.
- Lets non-shadow submission stay ready while Jangar dependency quorum blocks.
- Makes stale empirical proof and rollback-required hypotheses invisible to the main live gate.

Decision: reject as the default. Keep an emergency manual override with explicit expiry.

### Option B: Require Global Healthy Torghut Status

Set live submission false whenever any Torghut status segment is degraded.

Pros:

- Strong safety posture.
- Easy to test.
- Reduces accidental live capital during incidents.

Cons:

- Over-blocks observe and repair work.
- Does not distinguish market-closed expected staleness from market-open actionable staleness.
- Does not prioritize the highest expected profit repair.

Decision: reject as steady state.

### Option C: Capital Proof Reclocking Fuse

Build a `CapitalProofClock` that joins Jangar settlement, Torghut hypothesis readiness, empirical proof, signal and
market-context freshness, TCA, and rollback state for each account/window/hypothesis. Feed it into the live submission
gate and the Profit Repair Ledger.

Pros:

- One capital authority for simple, autonomous, and Jangar-visible paths.
- Blocks unsafe capital while preserving observe, shadow, and repair.
- Produces economic repair priorities instead of generic red status.
- Gives deployers one route-parity contract to validate before enabling live capital.

Cons:

- Requires route and scheduler refactoring.
- Requires careful handling for market-closed staleness so it does not page or freeze unnecessarily.
- Requires explicit emergency override semantics.

Decision: select Option C.

## Chosen Architecture

### CapitalProofClock

Add a materialized clock per account/window/hypothesis.

Required fields:

- `clock_id`
- `account`
- `window`
- `hypothesis_id`
- `observed_at`
- `fresh_until`
- `requested_capital_stage`
- `allowed_capital_stage`
- `decision`: `allow`, `shadow_only`, `repair_only`, `hold`, or `unknown`
- `jangar_rollout_settlement_digest`
- `jangar_external_capital_allowed`
- `empirical_job_freshness`
- `signal_lag_seconds`
- `market_session_state`
- `market_context_state`
- `tca_budget_state`
- `hypothesis_state`
- `rollback_required`
- `reason_codes`
- `repair_priority_score`
- `proof_refs`

### Live Submission Fuse

The live submission gate may return `allowed: true` for non-shadow capital only when at least one relevant
`CapitalProofClock` has `decision: allow` and no active clock for the account/window/hypothesis requires rollback.

The gate must return `allowed: false` with `capital_stage: shadow` or `repair_only` when:

- Jangar rollout settlement does not include `external_capital`.
- Jangar dependency quorum is `block`.
- Empirical jobs required by the hypothesis are stale or missing.
- Signal lag breaches the hypothesis entry contract during a market-open actionable window.
- Market context is required and stale.
- TCA absolute slippage or expected shortfall exceeds the hypothesis budget.
- The hypothesis ledger marks rollback required.

### Profit Repair Ledger Integration

Every held clock writes or updates a repair row with:

- the lost capital stage,
- expected post-cost edge if repaired,
- stale or missing proof ids,
- smallest proof needed to close,
- owner lane,
- expiry,
- and a note distinguishing market-closed expected staleness from actionable data loss.

The repair score is advisory. It is not realized PnL and must not be shown as profit.

## Engineer Scope

1. Add a pure `CapitalProofClock` builder in `services/torghut/app/trading/`.
2. Feed it with the existing hypothesis readiness compiler, empirical job state, Jangar dependency quorum payload,
   TCA metrics, signal continuity, and the new Jangar rollout settlement digest.
3. Make `build_live_submission_gate_payload` consume the clock instead of treating simple-lane readiness as enough for
   non-shadow capital.
4. Preserve a manual emergency override that requires reason, expiry, account, maximum notional, and proof refs.
5. Add route parity tests for `/trading/status`, readiness/control-plane contract payloads, scheduler decisions, and
   Jangar quant mirrors.

## Validation Gates

- Unit tests prove the current evidence shape produces `decision: hold` or `shadow_only`, not non-shadow `allow`.
- Regression tests prove `live_submission_gate.allowed` is false when dependency quorum blocks and all hypotheses are
  shadow or blocked.
- Regression tests prove market-closed expected staleness does not trigger emergency stop by itself, but it still
  prevents fresh non-shadow promotion unless the hypothesis contract explicitly allows it.
- Regression tests prove stale empirical jobs block promotion even when route liveness and simple-lane readiness are
  healthy.
- Property tests cover monotonic capital behavior: adding a rollback reason can only reduce allowed capital stage until
  a closing proof refreshes.
- Deployer smoke reads Torghut status and Jangar control-plane status and confirms their external-capital decisions
  agree.

## Rollout and Rollback

Roll out in three phases:

1. Shadow emit `capital_proof_clocks` and compare against current live submission decisions.
2. Enforce clocks for autonomous promotion and Jangar-visible capital first.
3. Enforce clocks for simple live submission after emergency override and route parity tests are green.

Rollback is configuration-only:

- Disable enforcement and keep emitting clocks.
- Cap manual live notional while enforcement is disabled.
- Keep repair ledger rows open until a fresh proof closes them.

## Handoff

Engineer acceptance gate: with the current runtime shape, Torghut must show live route liveness but deny non-shadow
capital because Jangar dependency quorum blocks, empirical jobs are stale, hypotheses are shadow or blocked, rollback is
required, and signal/proof clocks are not fresh.

Deployer acceptance gate: before enabling non-shadow capital, verify that Jangar settlement allows `external_capital`,
Torghut has at least one `CapitalProofClock.decision: allow`, `rollback_required_total` is 0 for the promoted account
and window, and route parity agrees across `/trading/status`, scheduler payloads, and Jangar quant control-plane
mirrors.
