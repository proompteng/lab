# 114. Torghut Convergence-Bound Proof Replay And Capital Readmission (2026-05-06)

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

Torghut will use **convergence-bound proof replay and capital readmission** before any hypothesis can move from shadow
to paper or live capital.

The latest read-only evidence says Torghut is operationally alive but not capital-ready. Kubernetes shows the live and
simulation routes running on the same Torghut image digest `b9156e2f...`, with live at `torghut-00234` and simulation at
`torghut-sim-00316`. Argo says the `torghut` application is `Healthy` but `OutOfSync`, including simulation analysis
templates, empirical promotion workflow state, historical simulation workflow state, and both Knative services.
Torghut `/db-check` is current at Alembic head `0029_whitepaper_embedding_dimension_4096`, and live dependencies can
reach Postgres, ClickHouse, Alpaca, and Jangar universe. The live route still returns HTTP `503` for readiness and
trading health because live submission is disabled, no hypothesis is promotion eligible, and quant evidence is
`quant_health_not_configured`.

The simulation route is not enough of a shortcut. Sim `/readyz` returns HTTP `200` in paper mode, but account-scoped
quant health for `TORGHUT_SIM` is degraded with no latest metrics and no pipeline stages. Live account quant health is
available through Jangar but stale enough for capital concern, with `metricsPipelineLagSeconds=53703`. Empirical proof
for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` is still based on the
March dataset `torghut-full-day-20260318-884bec35`. Market-context health for `AAPL` is degraded across technical,
regime, fundamentals, and news domains.

The selected architecture treats shadow as a proof factory and capital as a readmission event. Torghut can keep
zero-notional observation and proof-repair work running while Jangar records a convergence-bound ledger entry. Torghut
may only become a paper candidate when GitOps convergence, live/sim evidence contract parity, account-scoped quant
freshness, empirical replay, market-context freshness, and the Jangar promotion ledger all agree. Live capital then
requires the same proof plus live-submit rollback readiness and post-cost paper performance.

The tradeoff is that immediate paper promotion remains held. I accept that because the current blockers are profitable
work, not bureaucracy: refresh the proof, repair the sim quant store, wire live to typed evidence, and remove
unexplained drift. Spending capital before those facts converge would turn stale March evidence into a May trading
decision.

## Evidence Snapshot

No broker settings, Kubernetes resources, database rows, trading flags, or runtime configuration were changed during
this assessment.

### Cluster And Runtime Evidence

- Argo reported `torghut` `Healthy` and `OutOfSync` at main revision `3592eaf15cc7dc03f47fb2ef5d5545020a6ee8a3`.
- Out-of-sync resources included four simulation `AnalysisTemplate` objects, `torghut-historical-simulation`,
  `torghut-empirical-promotion`, and the live/sim Knative services.
- Torghut live deployment `torghut-00234-deployment` was `1/1` available on image digest `b9156e2f...`.
- Torghut sim deployment `torghut-sim-00316-deployment` was `1/1` available on the same digest.
- Torghut ClickHouse, Keeper, Postgres, websocket, options catalog/enricher, equity TA, sim TA, options TA, and
  guardrail exporter pods were running.
- Recent events showed sim startup/readiness probe failures that cleared, repeated ClickHouse multiple-PDB warnings,
  and Keeper PDB `NoPods` warnings.
- Direct listing of Knative `Service` and `Revision` objects is forbidden to this runtime, so Argo Application status,
  Deployment status, pod status, and service projections are the read-only surfaces.

### Database And Data Evidence

- `/db-check` returned HTTP `200`, `ok=true`, schema current, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, and account scope ready.
- Schema lineage still reports known parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; those warnings remain audit evidence but not the current head blocker.
- Live `/readyz` and `/trading/health` returned HTTP `503`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca, database schema, and Jangar universe.
- Live capital remained shadow: `live_submission_gate.allowed=false`, reason `simple_submit_disabled`,
  `promotion_eligible_total=0`, and `rollback_required_total=3`.
- Live quant evidence was not configured because `TRADING_JANGAR_QUANT_HEALTH_URL` is absent from the live route.
- Sim `/readyz` returned HTTP `200`, but its typed quant-health status was degraded:
  `latest_metrics_count=0`, `empty_latest_store_alarm=true`, and no pipeline stages for account `TORGHUT_SIM`.
- Live account `PA3SX7FYNUTF` quant health through Jangar returned HTTP `200`, but `metricsPipelineLagSeconds=53703`.
- `/trading/autonomy` reported stale empirical jobs for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`; all four refer to March proof artifacts.
- Jangar market-context health for `AAPL` was degraded with stale technicals, regime, fundamentals, and news.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already validates typed Jangar quant-health URLs, account labels,
  freshness windows, and submission blockers. It can be extended to consume a Jangar ledger id without inventing a new
  capital path.
- `argocd/applications/torghut/knative-service.yaml` keeps live submission disabled and configures Jangar control-plane
  status but not typed quant-health.
- `argocd/applications/torghut/knative-service-sim.yaml` configures typed Jangar quant-health for `TORGHUT_SIM`, so the
  empty store is a data-plane blocker rather than a missing URL.
- `services/torghut/app/trading/empirical_jobs.py`, `services/torghut/scripts/run_empirical_promotion_jobs.py`, and
  `services/torghut/tests/test_run_empirical_promotion_jobs.py` are the natural proof-replay implementation lane.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` and
  `services/jangar/src/server/torghut-quant-metrics-store.ts` are the Jangar-owned quant evidence surfaces Torghut must
  consume for account-scoped freshness.

## Problem

Torghut has the right fail-closed posture but not yet the right path back to capital. "Live disabled" prevents bad
orders, but it does not say which proof should be produced next, whether live and sim are converged with desired state,
or whether a current paper candidate has enough account-scoped data to justify risk.

The current state would let an operator tell two incomplete stories:

1. Torghut is healthy enough because live and sim pods are running and the database is current.
2. Torghut is blocked because live submission is disabled and empirical jobs are stale.

Both stories are true and incomplete. The missing fact is whether the capital path is converged: desired GitOps state,
runtime digest, sim/live evidence contracts, account quant stores, empirical artifacts, and Jangar promotion authority
must all identify the same proof window.

## Alternatives Considered

### Option A: Keep Shadow Until Manual Empirical Refresh Completes

Pros:

- Safest immediate capital posture.
- Requires no new route fields.
- Keeps live submission disabled.

Cons:

- Does not fix Argo `OutOfSync` or explain whether drift is intentional.
- Does not repair the empty sim account quant store.
- Keeps profitability dependent on manual operator timing and stale status interpretation.

Decision: reject as the architecture. Keep it as the rollback posture.

### Option B: Promote Paper When Sim Readiness Is HTTP 200

Pros:

- Gives the team a fast path to paper observation.
- Uses the route designed for non-live proof.
- Avoids waiting for live-submit changes.

Cons:

- Ignores the empty sim account-scoped quant store.
- Ignores stale empirical proof and market-context domains.
- Allows paper promotion while desired state is out of sync.

Decision: reject. HTTP readiness is not profit authority.

### Option C: Convergence-Bound Proof Replay And Capital Readmission

Pros:

- Turns shadow work into explicit proof debt retirement.
- Requires GitOps convergence before paper/live capital, without blocking repair.
- Forces live and sim to consume the same typed Jangar promotion ledger.
- Makes stale empirical proof and empty quant stores measurable blockers.
- Provides a clean rollback: revoke the ledger id and stay shadow.

Cons:

- Requires new status fields and submission-council integration.
- Delays paper canaries until convergence and replay are demonstrably current.
- Requires careful handling of intentional live/sim differences.

Decision: select Option C.

## Profit Hypotheses And Guardrails

Hypothesis 1: **Converged proof replay creates higher-quality paper candidates.** Rerun the four stale empirical jobs
for `intraday_tsmom_v1@prod` against a current dataset and holdout window. Success is all four receipts fresh inside
`24h`, post-cost score above the configured hurdle, and no capital candidate without a Jangar ledger id.

Hypothesis 2: **Repairing the sim account quant store reduces false capital holds.** Fill account-scoped latest metrics
and pipeline stages for `TORGHUT_SIM`. Success is `latest_metrics_count > 0`, no `empty_latest_store_alarm`, and paper
candidate evaluation that cites the same account/window as the replay artifact.

Hypothesis 3: **GitOps convergence reduces promotion false positives.** A paper/live candidate is not considered until
Argo convergence is clean or the drift is explicitly classified as known repair-only. Success is no candidate emitted
when analysis templates, empirical workflow templates, or Knative services are unexplained `OutOfSync`.

Hypothesis 4: **Negative market context improves capital allocation.** Stale technical, regime, fundamentals, or news
domains should reduce hypothesis priority or consume repair budget before capital. Success is a replay record that
names stale domains and either refreshes them or holds the candidate.

Guardrails:

- No live orders while `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
- No paper candidate while the Jangar ledger decision is `hold` or `repair_only`.
- No capital candidate when sim account quant health is empty or live account lag exceeds the action window.
- No live micro-canary until paper performance, TCA, drawdown bounds, market-context freshness, and rollback target are
  current.
- No promotion from an Argo `OutOfSync` state unless the Jangar ledger marks the drift intentional and capital-safe.

## Architecture

Torghut adds a `capital_readmission_record` that consumes Jangar's promotion ledger:

```text
capital_readmission_record
  record_id
  jangar_ledger_id
  hypothesis_ref
  account_ref
  requested_stage              # shadow, paper_candidate, paper_active, live_micro_canary, live_scale
  desired_state_ref
  runtime_digest_ref
  live_sim_parity_ref
  sim_quant_health_ref
  live_quant_health_ref
  empirical_replay_refs
  market_context_refs
  tca_ref
  post_cost_performance_ref
  decision                     # observe_only, repair_only, hold_capital, paper_candidate, live_candidate
  held_reasons
  rollback_target
  expires_at
```

The submission council becomes a consumer of the Jangar ledger instead of an independent capital arbiter. It can still
report local blockers, but paper/live decisions must cite the ledger id and the readmission record id. Local health
cannot upgrade a Jangar `hold`; it can only add more held reasons.

The replay runner emits `proof_replay_receipt` rows or artifacts:

```text
proof_replay_receipt
  receipt_id
  hypothesis_ref
  dataset_ref
  holdout_window
  job_type
  artifact_refs
  completed_at
  fresh_until
  post_cost_metrics
  negative_evidence_refs
```

The readmission reducer joins those receipts with account-scoped quant health. If sim is empty, the decision is
`repair_only`. If live quant lag exceeds the capital window, live stages hold even when paper is healthy.

## Implementation Scope

Engineer stage should:

- Add Jangar ledger id and readmission record fields to `/readyz`, `/trading/health`, `/trading/status`, and
  `/trading/autonomy`.
- Extend `submission_council.py` so local Torghut health can only downgrade a Jangar ledger decision, not upgrade it.
- Configure live to consume the typed Jangar quant-health URL while keeping live submission disabled.
- Repair the `TORGHUT_SIM` account quant latest-store path and add tests for empty latest store, missing pipeline
  stages, and stale account windows.
- Add proof replay orchestration for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` with dataset id, holdout window, artifact refs, and freshness deadline.
- Add market-context negative-evidence refs to the replay/readmission decision.
- Add a deployer-facing summary that shows stage, decision, held reasons, ledger id, and rollback target.

## Validation Gates

- Unit: sim `/readyz` HTTP `200` plus `empty_latest_store_alarm=true` yields `repair_only`, not `paper_candidate`.
- Unit: live missing typed quant-health URL yields `hold_capital` until configured.
- Unit: Argo `Healthy/OutOfSync` without known drift classification holds paper and live stages.
- Unit: stale empirical replay receipts hold capital and list all stale job types.
- Unit: local Torghut health cannot upgrade a Jangar ledger `hold`.
- Integration: `/readyz`, `/trading/health`, `/trading/status`, and `/trading/autonomy` cite the same ledger and
  readmission ids.
- Data gate: replay receipts must include dataset id, holdout window, completion time, artifact refs, post-cost
  metrics, and freshness deadline.
- Rollout gate: live remains shadow until the readmission record is at least `paper_candidate` and deployer rollback is
  executable without database mutation.

## Rollout And Rollback

Phase 0: emit readmission records in shadow and keep all current behavior. Rollback is to hide the additive fields.

Phase 1: wire live to typed Jangar quant-health, still with `TRADING_SIMPLE_SUBMIT_ENABLED=false`. Rollback is to remove
the live typed evidence URL and keep the explicit missing-URL hold.

Phase 2: repair sim account quant health and replay empirical proof. Rollback is to keep the record at `repair_only`
and stop replay scheduling.

Phase 3: allow paper candidates only when Jangar ledger, GitOps convergence, sim quant health, replay receipts, and
market-context evidence are current. Rollback is to revoke the ledger id and return all candidates to shadow.

Phase 4: consider live micro-canary only after paper performance, TCA, drawdown bounds, and live account quant freshness
clear the configured hurdles. Rollback is immediate shadow, live submission disabled, and no reuse of the revoked
ledger id.

## Risks

- GitOps drift can be intentionally ignored. The readmission record must distinguish known intentional differences from
  unknown drift and never treat unknown drift as capital-safe.
- Proof replay can overfit a convenient window. The receipt requires a named holdout window and post-cost metrics.
- Account-scoped quant stores can lag near market close. The capital window should be action-class specific and should
  allow observation without capital when markets are closed.
- The live route could become configured for typed quant health but still leave empirical proof stale. The submission
  council must require all refs, not just the newest one.
- A paper candidate can be mistaken for live permission. Stage names must remain explicit and live submission stays
  disabled until a separate live ledger entry exists.

## Handoff

Engineer acceptance gate: implement capital readmission records, wire live typed quant health without enabling live
orders, repair sim account quant health, replay the four stale empirical jobs with fresh dataset and holdout refs, and
add tests for empty sim quant, missing live quant URL, stale empirical proof, Argo drift, and local downgrade-only
submission-council behavior.

Deployer acceptance gate: keep Torghut in shadow unless the requested stage has a fresh Jangar ledger id and a matching
readmission record, GitOps convergence is clean or intentionally waived, account-scoped quant health is fresh, empirical
replay receipts are current, market-context blockers are handled, and rollback is live-submission-disabled plus
ledger-id revocation.
