# 113. Torghut Live/Sim Parity And Empirical Proof Replay Escrow (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and changed: empirical status/proof concepts remain in code, but old empirical job scripts and Argo workflow templates were removed.
- Matched implementation area: Empirical jobs and promotion evidence.
- Current source evidence:
  - `services/torghut/app/trading/empirical_jobs.py`
  - `services/torghut/app/api/health_checks/shared_context.py`
  - `services/torghut/app/trading/profit_windows.py`
  - `services/torghut/app/trading/profit_leases.py`
  - `services/torghut/scripts/build_historical_profitability_proof.py`
- Design drift note: Old empirical-promotion scripts/templates must not be cited as live source authority.


## Decision

Torghut will use **live/simulation parity and empirical proof replay escrow** before it promotes any hypothesis from
shadow to paper or live capital.

The current state is conservative for the right reason, but not yet profitable. Torghut live has a healthy Postgres
schema at Alembic head `0029_whitepaper_embedding_dimension_4096`, ClickHouse is reachable, Alpaca reports the live
account active, and the scheduler is up. The same `/trading/health` surface reports `live_submission_gate.allowed=false`,
`simple_submit_disabled`, `capital_stage=shadow`, `promotion_eligible_total=0`, and `rollback_required_total=3`.
`/trading/autonomy` reports stale empirical jobs for `benchmark_parity`, `foundation_router_parity`,
`janus_event_car`, and `janus_hgrm_reward` over `intraday_tsmom_v1@prod`.

There is also a consumer-parity problem. The simulation route is configured with Jangar control-plane and quant-health
URLs. The live route keeps live submission disabled and does not expose the same typed Jangar quant-health contract, so
the live submission council reports `quant_health_not_configured` even while Jangar can serve quant-health projections.
That mismatch is not a minor config cleanup. It means sim can produce evidence under a control-plane contract that live
does not consume.

The selected architecture keeps live orders disabled while turning shadow into a measured proof factory. Torghut may run
zero-notional observations and proof-repair jobs under a Jangar replay cell. It may not paper trade, live micro-canary,
or scale until live/sim parity is clean, empirical replay receipts are fresh, account-scoped quant-health is current,
and the submission council cites the same Jangar replay cell that authorized the action.

The tradeoff is that the first profitable step is proof production, not immediate capital. I accept that because stale
March empirical proof should not be used to trade in May. Profitability improves when the system can quickly convert
fresh market data into replay receipts and then spend small, bounded capital only after the evidence chain agrees.

## Evidence Snapshot

No broker settings, Kubernetes resources, database rows, or trading flags were changed during this assessment.

- Torghut live and simulation revisions are running in Kubernetes. Recent simulation startup/readiness failures cleared
  before the latest revision became ready.
- Torghut `/db-check` reports `ok=true`, schema current, account scope ready, and expected/current head
  `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage still contains known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`; they are not current blockers
  but remain part of the data-quality audit trail.
- Torghut `/trading/health` is degraded because live submission is disabled, no hypothesis is promotion eligible, and
  dependency quorum is blocked by empirical-job degradation.
- Torghut `/trading/autonomy` reports autonomy disabled, stale empirical jobs over dataset
  `torghut-full-day-20260318-884bec35`, and no emergency stop active.
- Jangar aggregate quant-health is fresh, but account-scoped live quant-health lag is large enough that capital should
  require a narrower freshness window.
- Market-context health for `AAPL` is degraded by stale technical, regime, fundamentals, and news domains. This is
  useful negative evidence for a replay cell, not a reason to unlock capital.
- `argocd/applications/torghut/knative-service-sim.yaml` configures Jangar control-plane status and quant-health URLs for
  simulation. `argocd/applications/torghut/knative-service.yaml` does not match those typed evidence inputs for live.

## Problem

Torghut has useful infrastructure but insufficient proof freshness. The system can reach its databases, broker, and
market-data projections. It cannot yet explain which hypothesis deserves capital today, which evidence window proved
it, and whether live is consuming the same control-plane evidence contract as sim.

Without this architecture, the team has two bad options. It can leave live submission disabled and slowly accumulate
stale debt, or it can manually bypass the gate when fresh-looking route or quant metrics are available. The first option
leaves profit on the table. The second option lets partial freshness masquerade as capital readiness.

The better path is to make shadow work accountable. Every shadow observation and proof-repair run should either retire
a named blocker or produce negative evidence that keeps the hypothesis out of capital.

## Alternatives Considered

### Option A: Keep Live Disabled Until A Manual Empirical Refresh

Pros:

- Lowest capital risk.
- Requires no new status model.
- Preserves the current fail-closed posture.

Cons:

- Does not solve live/sim control-plane drift.
- Does not convert fresh market context or options enrichment into usable proof.
- Keeps profitability dependent on manual operator timing.

Decision: reject as the main strategy. Keep it as the rollback posture.

### Option B: Require Jangar Quant Health And Promote From Local Torghut Gates

Pros:

- Faster to implement.
- Gives Torghut a typed Jangar input.
- Improves over `quant_health_not_configured`.

Cons:

- Still lets quant freshness outrank stale empirical jobs.
- Does not prove live and simulation are using the same evidence contract.
- Does not produce replay receipts for deployers or capital reviewers.

Decision: reject. Quant health is one input, not capital authority.

### Option C: Live/Sim Parity Plus Empirical Proof Replay Escrow

Pros:

- Forces live and simulation to consume the same typed evidence contract before capital.
- Lets zero-notional and proof-repair work proceed under observe-only authority.
- Turns stale empirical jobs into named replay obligations with measurable output.
- Gives submission council and Jangar one shared cell id for promotion decisions.

Cons:

- Adds orchestration work for proof replay and parity status.
- Requires careful operator language so observe-only is not read as paper/live permission.
- May delay paper canaries until the first replay window completes.

Decision: select Option C.

## Profit Hypotheses And Guardrails

Hypothesis 1: **Replay-retired TSMOM shadow debt**. Rerun `benchmark_parity`, `foundation_router_parity`,
`janus_event_car`, and `janus_hgrm_reward` for `intraday_tsmom_v1@prod` with a current dataset and explicit holdout
window. Success is all four receipts fresh inside `24h`, no emergency stop, and no paper promotion unless post-cost
performance clears the configured hurdle.

Hypothesis 2: **Live/sim parity lifts false-negative blocks**. After live consumes the same Jangar replay-cell and
quant-health contract as sim, the submission council should move blockers from `quant_health_not_configured` to specific
freshness or empirical reasons. Success is a health payload that cites one Jangar replay cell id and shows the same
decision in `/readyz`, `/trading/health`, `/trading/status`, and `/trading/autonomy`.

Hypothesis 3: **Negative market-context evidence improves capital allocation**. Stale technical, regime,
fundamental, and news domains should lower hypothesis priority until refreshed, rather than silently living outside the
capital gate. Success is a replay cell that records stale domains as negative evidence and allocates repair budget to the
highest expected-value refresh first.

Guardrails:

- No live orders while `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
- No paper canary without fresh empirical replay and account-scoped quant-health.
- No live micro-canary without current TCA coverage, rollback target, and matching Jangar replay cell id.
- No scale-up without observed post-cost performance and bounded drawdown evidence.

## Architecture

Torghut adds two projection surfaces.

`live_sim_parity_manifest` explains whether live and simulation consume the same control-plane contract:

```text
live_sim_parity_manifest
  manifest_id
  generated_at
  live_route_ref
  sim_route_ref
  control_plane_status_url_match
  quant_health_url_match
  quant_health_required_policy
  empirical_jobs_required_policy
  submission_gate_policy
  intentional_differences        # account id, broker mode, live submit flag
  parity_decision                # pass, warn, hold_capital
  held_reasons
```

`empirical_replay_escrow` turns stale proof into a promotion obligation:

```text
empirical_replay_escrow
  escrow_id
  jangar_replay_cell_id
  hypothesis_ref
  account_ref
  dataset_ref
  replay_window
  required_jobs
  completed_jobs
  market_context_refs
  tca_ref
  decision                       # allow_observe, allow_repair, hold_capital, paper_candidate
  expires_at
```

The submission council consumes both projections. If parity is `hold_capital`, capital stays blocked even when local
database and broker probes are healthy. If replay escrow is `allow_repair`, Torghut can run proof jobs and
zero-notional observations but cannot submit paper or live orders. If replay escrow is `paper_candidate`, Jangar must
still issue a fresh replay cell before paper promotion.

## Implementation Scope

Engineer stage should:

- Add live/sim parity reporting near existing Torghut health and submission-council evidence.
- Configure live to consume the same typed Jangar control-plane and quant-health contracts as simulation, while keeping
  intentional account and broker-mode differences explicit.
- Add proof-replay orchestration for the four stale empirical jobs and current TCA coverage.
- Add account-scoped quant-health freshness checks to the capital path.
- Surface the Jangar replay cell id, parity manifest id, and replay escrow id in `/readyz`, `/trading/health`,
  `/trading/status`, and `/trading/autonomy`.

## Validation Gates

- Unit test: missing live Jangar quant-health URL yields `parity_decision=hold_capital`.
- Unit test: sim/live account and broker-mode differences are allowed only when marked intentional.
- Unit test: stale empirical jobs produce `allow_repair` but not `paper_candidate`.
- Unit test: current empirical replay, current account quant-health, and matching Jangar replay cell produce a
  `paper_candidate` decision while live submission remains disabled.
- Integration test: all public health surfaces cite the same parity manifest and replay escrow decision.
- Data gate: replay receipts must include dataset id, job id, completion time, freshness deadline, and post-cost metric.

## Rollout And Rollback

Phase 0: publish parity and replay-escrow fields in shadow. No order behavior changes.

Phase 1: wire live to the typed Jangar evidence contract while keeping `TRADING_SIMPLE_SUBMIT_ENABLED=false`. Rollback is
to remove the live consumer config and keep the explicit parity hold.

Phase 2: run proof replay and zero-notional observations under `allow_repair`. Rollback is to stop scheduling replay
jobs and keep empirical debt as the active blocker.

Phase 3: allow paper candidates only when replay escrow and Jangar replay cell agree. Rollback is to force
`hold_capital` and leave live submission disabled.

Phase 4: consider live micro-canary only after paper evidence clears the hurdle with current TCA and drawdown bounds.
Rollback is immediate return to shadow, explicit replay-cell revocation, and broker submission disabled.

## Risks

- Live/sim parity can produce false holds if intentional differences are modeled too narrowly. The manifest must keep
  account id, broker mode, and live-submit flag separate from missing evidence inputs.
- Proof replay can overfit if it only refreshes one favorable market window. Promotion requires a named holdout window
  and post-cost metrics.
- Account-scoped quant-health may lag aggregate health during market close or backfill windows. The freshness policy
  must be action-class specific.
- Zero-notional observations do not prove execution quality unless they record spread, depth, simulated fill quality,
  and TCA linkage.

## Handoff

Engineer acceptance gate: implement parity and replay-escrow projections, wire the live route to typed Jangar evidence
without enabling live orders, and add tests for missing URL, intentional live/sim differences, stale replay, and paper
candidate settlement.

Deployer acceptance gate: keep Torghut at shadow until `/readyz`, `/trading/health`, `/trading/status`, and
`/trading/autonomy` cite the same Jangar replay cell, parity manifest, replay escrow decision, and rollback target for
the requested action.
