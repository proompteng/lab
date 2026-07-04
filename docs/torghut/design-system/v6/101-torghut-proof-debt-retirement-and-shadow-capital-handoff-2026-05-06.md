# 101. Torghut Proof Debt Retirement And Shadow Capital Handoff (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: historical simulation, replay, Lean backtest APIs, and local replay scripts exist, but older monolithic simulation assumptions have been split.
- Matched implementation area: Simulation, replay, backtesting, and Lean.
- Current source evidence:
  - `services/torghut/scripts/run_local_simple_lane_replay.py`
  - `services/torghut/scripts/verify_historical_simulation_parity.py`
  - `services/torghut/app/api/trading_misc/lean_backtests.py`
  - `services/jangar/src/routes/api/torghut/simulation/runs.ts`
  - `argocd/applications/torghut/historical-simulation-workflowtemplate.yaml`
- Design drift note: Simulation docs must be checked against current split scripts and Jangar simulation routes.


## Decision

Torghut should implement a **proof debt retirement queue with a shadow capital handoff** before any paper or live capital
reentry.

The current live state is safer than the original shared soak but still not profitable. Torghut is serving, schema is
current, Postgres, ClickHouse, Alpaca, and scheduler checks are OK, and live submission is blocked at `capital_stage:
shadow`. That is the right capital posture. The profit problem is that Torghut has proof debt with no ranked retirement
contract: stale empirical jobs, stale market-context domains, zero universe symbols, zero promotion-eligible
hypotheses, three rollback-required hypotheses, and no configured scoped quant proof in the live submission gate.

The architecture move is to keep observe and zero-notional repair open, retire proof debt in ranked order, and route
only shadow capital through lanes that can cite fresh proof. Paper and live capital remain closed until the proof debt
queue produces fresh receipts and Jangar's discover cutover receipt allows the corresponding action class.

The tradeoff is that Torghut may remain shadow-only longer than a route-liveness view would suggest. I accept that. A
healthy broker connection and current schema are prerequisites, not profit evidence.

## Evidence Snapshot

All checks were read-only.

### Cluster And Route Evidence

- Torghut live revision `torghut-00225-deployment-6c9bbff5f6-bj9xx` and simulation revision
  `torghut-sim-00306-deployment-75fb7bf4d9-c2k7m` were `2/2 Running`.
- ClickHouse replicas, Keeper, Torghut Postgres, TA services, options services, websocket services, Alloy, and guardrail
  exporters were running.
- Torghut recent events showed repeated `MultiplePodDisruptionBudgets` warnings on ClickHouse pods and `NoPods` on the
  keeper PDB. This is not a trading signal, but it is route-cost evidence for rollout and repair budgeting.
- `/healthz` returned HTTP 200 with `status="ok"`.
- `/trading/health` returned HTTP 503 with `status="degraded"`. Dependency details were specific: Postgres,
  ClickHouse, Alpaca, scheduler, readiness cache, DSPy runtime, and quant evidence did not block the route; empirical
  jobs were degraded, universe evaluation had zero symbols, and live submission was blocked by `simple_submit_disabled`.
- `/trading/status` returned `running=true`, `mode="live"`, `kill_switch_enabled=false`, and
  `live_submission_gate.allowed=false` with `capital_stage="shadow"`.

### Database, Schema, And Freshness Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, no duplicate revisions, no orphan
  parent references, and lineage-ready state.
- Known parent-fork warnings remain for `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`. The warnings are audit evidence, not a reason to block zero-notional repair.
- Account-scope checks were ready, with a warning that checks are bypassed while multi-account trading is disabled.
- Jangar market-context health for `NVDA` was degraded:
  - technicals stale by 15,456 seconds against a 60 second max;
  - regime stale by 15,456 seconds against a 120 second max;
  - fundamentals stale by 4,706,690 seconds against an 86,400 second max;
  - news stale by 4,361,461 seconds against a 300 second max.
- Fundamentals and news provider attempts succeeded at the current timestamp. That proves provider reachability, not
  bundle freshness.

### Profit And Capital Evidence

- Alpha readiness had three hypotheses, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
- Jangar dependency quorum blocked on `empirical_jobs_degraded`.
- Live submission was disabled by `simple_submit_disabled` and stayed at shadow capital.
- Quant evidence was `not_required` and `quant_health_not_configured`, which means route-level trading health is not
  consuming scoped quant proof for account/window promotion.
- Universe evidence was not usable for promotion: the route reported source `jangar`, zero symbols, and
  `require_non_empty=true`.

### Source And Test Evidence

- `services/torghut/app/trading/submission_council.py` already owns live submission, capital stages, empirical jobs,
  Jangar dependency quorum, quant evidence, and promotion gating.
- `services/torghut/app/trading/hypotheses.py` already compiles promotion eligibility, rollback requirement, signal
  continuity, market-context freshness, evidence continuity, and capital stage.
- `services/torghut/app/trading/empirical_jobs.py` classifies empirical job age, authority, candidate, dataset snapshot,
  and promotion eligibility.
- `services/torghut/app/main.py` exposes the health, status, DB-check, empirical job, and profitability routes that
  Jangar should consume by digest.
- Torghut has 147 Python test files. The missing regression is the proof-retirement handoff: this current degraded shape
  must allow observe and repair, keep shadow capital only, and deny paper/live even though broker and database checks are
  OK.

## Problem

Torghut is safe by default today, but the path out of shadow capital is still too implicit.

The current failure modes are:

1. **Proof debt is visible but not queued.** Stale empirical jobs, stale market context, and an empty universe are known,
   but they are not ranked as retireable debts with receipts.
2. **Route liveness and profit authority can diverge.** `/healthz` is OK and broker connectivity is OK while
   `/trading/health` correctly returns degraded.
3. **Shadow capital lacks scoped proof.** Shadow is the right capital stage, but shadow experiments should still cite
   current market context, universe proof, and account/window quant proof.
4. **Jangar cannot consume broad status safely.** Jangar needs compact proof-debt receipts and action decisions, not a
   large trading status payload with route-local semantics.

## Alternatives Considered

### Option A: Open Paper Capital As Soon As Simple Submission Is Enabled

Pros:

- Fastest path to paper executions.
- Uses the existing live submission gate.
- Produces new TCA samples quickly.

Cons:

- Ignores stale empirical jobs and market context.
- Ignores zero universe symbols.
- Promotes a configuration toggle into profit authority.
- Lets scoped quant proof remain optional.

Decision: reject. A toggle cannot replace proof.

### Option B: Refresh The Four Empirical Jobs And Recheck

Pros:

- Directly targets the current dependency quorum blocker.
- Likely improves Jangar status quickly.
- Uses existing empirical job definitions.

Cons:

- Does not fix stale market context.
- Does not fix universe proof.
- Does not wire scoped quant proof into capital gates.
- Recreates manual judgment after the next stale window.

Decision: required first repair cargo, but not enough as architecture.

### Option C: Proof Debt Retirement Queue And Shadow Capital Handoff

Torghut materializes a ranked proof debt queue, emits retirement receipts, and lets Jangar consume compact shadow,
paper, and live capital decisions.

Pros:

- Converts degraded readiness into prioritized repair.
- Keeps observe and repair open while capital remains fail-closed.
- Forces empirical freshness, market-context freshness, universe proof, and scoped quant evidence into one handoff.
- Gives deployers objective gates before paper or live reentry.

Cons:

- Requires new route contracts and tests.
- Requires expiry logic so retired debts reopen when proof stales.
- Requires Jangar and Torghut to agree on action-class vocabulary.

Decision: select Option C.

## Chosen Architecture

### ProofDebtQueue

Torghut publishes a compact queue for Jangar and deployer consumption:

```text
proof_debt_queue
  queue_id
  generated_at
  fresh_until
  account
  window
  debts
  ranked_repairs
  capital_decisions
  route_budget
  evidence_digest
```

Each debt includes:

```text
proof_debt
  debt_id
  debt_type
  affected_hypotheses
  affected_symbols
  current_state
  required_state
  blocks_action_classes
  repair_owner
  expected_profit_evidence_lift
  stale_since
  expires_at
  closing_receipt_type
```

Initial debt types:

- `empirical_jobs_stale`
- `market_context_stale`
- `universe_empty`
- `hypothesis_rollback_required`
- `quant_scope_missing`
- `clickhouse_pdb_conflict`

### ProofDebtRetirementReceipt

Every repair job that claims to close debt emits:

```text
proof_debt_retirement_receipt
  receipt_id
  debt_id
  repair_job_ref
  observed_at
  proof_fresh_until
  before_digest
  after_digest
  decision
  reason_codes
  capital_unlock_candidate
```

`capital_unlock_candidate` is advisory. It cannot authorize paper or live capital without Jangar's cutover receipt and
the capital decision below.

### Shadow Capital Handoff

Capital decisions are emitted separately:

```text
shadow_capital_handoff
  handoff_id
  account
  window
  hypothesis_id
  generated_at
  fresh_until
  observe_decision
  repair_decision
  shadow_decision
  paper_decision
  live_decision
  required_receipts
  jangar_cutover_receipt
  reason_codes
```

Current-state required decisions:

- `observe_decision=allow`
- `repair_decision=allow` for empirical and market-context proof repair
- `shadow_decision=allow` only for lanes with route and schema proof
- `paper_decision=block`
- `live_decision=block`

## Measurable Trading Hypotheses

- Retiring the four stale empirical jobs will change Jangar dependency quorum from `block` to either `allow` or a more
  precise non-empirical blocker within the configured freshness window.
- Freshening market context for the active universe will reduce stale-domain reason codes for strategies that require
  technicals, news, fundamentals, or regime input, and will not unlock unrelated strategies that do not require those
  domains.
- Requiring non-empty universe proof will reduce false promotion opportunities where broker/schema health is green but
  no tradable symbol set is proven.
- Wiring scoped quant proof into the submission council will eliminate `quant_health_not_configured` from capital proof
  for the target account/window without treating aggregate metrics as scoped proof.
- Keeping paper/live blocked until all receipts are fresh will improve post-cost paper acceptance quality compared with
  enabling paper capital on route liveness alone.

Each hypothesis can falsify the lane. A failed repair receipt should retire, demote, or quarantine the hypothesis rather
than pushing for capital anyway.

## Implementation Scope

Engineer stage:

1. Build the proof debt queue from existing empirical job, market-context, universe, hypothesis, quant, and PDB evidence.
2. Add a compact Jangar-facing route that returns the queue, top repairs, capital decisions, and digest refs.
3. Emit retirement receipts from empirical and market-context repair jobs.
4. Feed scoped quant proof into submission-council capital decisions.
5. Add tests for the current evidence shape: observe and repair allowed, paper/live blocked, shadow only, and all listed
   debts present.

Deployer stage:

1. Verify Torghut `/healthz`, `/db-check`, `/trading/health`, `/trading/status`, and the new proof-debt route agree on
   capital stage.
2. Verify empirical job repair closes `empirical_jobs_stale` or emits a falsification receipt.
3. Verify market-context repair closes only the domains it actually freshens.
4. Verify paper/live remain blocked while universe is empty, hypotheses require rollback, or scoped quant proof is
   missing.
5. Verify Jangar cutover receipt consumes the compact handoff, not the full trading status payload.

## Validation Gates

- Unit tests for queue ranking and retirement receipt decisions.
- Route parity tests proving `/trading/health` HTTP 503 still yields observe/repair allowance and paper/live block.
- Regression tests proving broker OK plus schema current is insufficient for paper/live capital.
- Regression tests proving a stale market-context domain blocks only hypotheses that depend on that domain.
- Property tests for monotonic capital behavior: adding proof debt cannot increase allowed capital stage.
- Documentation and formatter checks pass.

## Rollout And Rollback

Roll out in shadow:

1. Emit the proof debt queue and handoff with no capital enforcement change.
2. Compare handoff decisions against current `/trading/health` and Jangar cutover receipt.
3. Enforce repair routing first.
4. Enforce paper-capital blocks next.
5. Consider live-capital evaluation only after paper receipts produce fresh TCA and post-cost evidence.

Rollback is configuration-only:

- Disable proof-debt enforcement and keep emitting queue snapshots.
- Keep capital capped at shadow while enforcement is disabled.
- Do not delete debt or retirement receipts; mark them ignored by policy version.
- If the queue builder fails, Jangar must treat paper/live as blocked and allow only observe plus explicitly scoped
  repair.

## Risks

- A proof debt score can be mistaken for expected profit. It is only expected evidence lift until paper/live results
  prove otherwise.
- Provider reachability can be mistaken for context freshness. The receipt must carry bundle freshness by domain.
- Shadow routes can become a soft live path if order-placement permissions are not separated.
- PDB and infrastructure route-cost evidence can over-rank repair unless it is bounded to the affected ClickHouse lanes.

## Handoff

Engineer acceptance gate: with the current 2026-05-06T01:08Z evidence shape, the queue lists stale empirical jobs,
stale market context, empty universe, rollback-required hypotheses, missing scoped quant proof, and ClickHouse PDB
conflict evidence; it allows observe and repair, keeps shadow capital bounded, and blocks paper/live.

Deployer acceptance gate: before paper or live reentry, require fresh empirical receipts, lane-fresh market context,
non-empty universe proof, scoped quant proof, zero active rollback-required hypotheses for the lane, and a Jangar
discover cutover receipt that explicitly allows the requested capital action class.
