# 85. Torghut Proof-Fresh Profitability Governor and Causal Replay Quarantine (2026-05-05)

Status: Approved for implementation (`discover`)

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

Torghut should move from route-level readiness to a **Proof-Fresh Profitability Governor** backed by a **Causal Replay
Quarantine**. The governor keeps capital in shadow when proof is stale, but it does not stop learning. It converts every
planned decision that cannot reach the broker into replayable causal evidence, then requires fresh empirical jobs,
runtime profitability samples, Jangar action-class authorization, and route parity before paper or live capital widens.

I am choosing this direction because the current state is not a pure outage and not a profit-ready system. The
2026-05-05T18:20Z read-only evidence refresh shows:

- `GET /healthz` on private revision `torghut-00217` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `GET /db-check` returned `ok=true`, `schema_current=true`, `current_heads=["0029_whitepaper_embedding_dimension_4096"]`,
  and `schema_graph_lineage_ready=true`, with warnings for historical migration parent forks.
- `GET /readyz` and `GET /trading/health` returned HTTP 503 with the scheduler running, Postgres and ClickHouse
  healthy, Alpaca broker checks healthy, and `live_submission_gate.ok=false`.
- `/trading/status` showed mode `live`, active revision `torghut-00217`, build commit
  `59511b6b6af8b160aaf00b9fb5f44b7a62c61c5c`, and `live_submission_gate.allowed=false` because
  `simple_submit_disabled`.
- The same status showed 3 hypotheses: 1 blocked, 2 shadow, 0 promotion eligible, 3 rollback required, and all capital
  stage totals in `shadow`; signal continuity was alerting on `cursor_tail_stable`.
- `/trading/empirical-jobs` reported all four proof jobs stale: `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all tied to the March dataset snapshot
  `torghut-full-day-20260318-884bec35`.
- `/trading/profitability/runtime` reported an observational 72-hour window with 8 rejected decisions, 0 executions,
  0 TCA samples, and a realized PnL proxy of 0.
- The Jangar quant-health route timed out after eight seconds, while direct SQL into Torghut Postgres and Jangar
  Postgres was blocked by service-account RBAC.

This evidence says the right capital decision is quarantine, not shutdown. Torghut should keep producing decisions,
shadow fills, replay bundles, and repair evidence, but it should not treat those as paper or live authority until the
proof is fresh and executable.

## Problem

Torghut has a profitability bottleneck that is more subtle than "the service is down." The route can answer, the schema
can be aligned, and the scheduler can run while the system still has no recent execution or TCA sample to support
capital widening. Worse, stale empirical jobs can be truthful and historically useful while being too old for live
capital.

That creates three risks:

1. capital widens from liveness instead of profit proof;
2. disabled submissions produce no learning signal and silently waste market sessions;
3. stale but truthful artifacts get read as current proof.

The architecture needs to make every non-executed decision useful for learning while making every capital promotion
depend on current, executable proof.

## Evidence Snapshot

### Cluster and Rollout Evidence

Read-only Kubernetes evidence showed Torghut serving with churn:

- Torghut, Torghut simulation, Postgres, ClickHouse, Keeper, websocket forwarders, options services, TA services, and
  exporters were running in namespace `torghut`.
- The latest live and sim Knative revisions were `torghut-00217` and `torghut-sim-00297`; both pods were `2/2 Running`
  during the refresh, after startup and readiness probe failures during rollout.
- Recent `agents` namespace jobs still showed active and stale failures: older Jangar and Torghut swarm attempts were
  `Failed`, three long-running attempts were stuck around old image pull failures, and current digest cron/manual jobs
  were completing.
- Events showed ClickHouse pods matching multiple PodDisruptionBudgets and Keeper PDB checks with no matching pods.
- Flink technical analysis was running, but events included external status modification warnings.

Interpretation: the platform is available enough for route checks and data repair. It is not stable enough to use pod
readiness or a single successful revision as a capital signal.

### Source and Test Evidence

The relevant source path is already close to the right shape:

- `services/torghut/app/trading/submission_council.py` centralizes live-submission gate logic.
- `services/torghut/app/trading/empirical_jobs.py` distinguishes truthful empirical artifacts from stale or ineligible
  proof.
- `services/torghut/app/trading/hypotheses.py` compiles hypothesis runtime states and dependency quorum.
- `services/torghut/app/main.py` exposes `/trading/status`, `/trading/health`, `/trading/empirical-jobs`, and
  `/trading/profitability/runtime`.

The risk is coordination across a large route surface. `main.py` has 3981 lines, `submission_council.py` has 1196
lines, `empirical_jobs.py` has 561 lines, `hypotheses.py` has 732 lines, `test_trading_api.py` has 3505 lines, and
`test_submission_council.py` has 603 lines. The code has many focused tests, but the next implementation needs
cross-route acceptance tests that prove the status route, health route, profitability route, scheduler, and broker-bound
submission council all read the same proof cut.

### Database and Data Evidence

Database proof is mixed:

- Application-level schema proof is healthy through `/db-check`.
- Direct SQL is unavailable from this runner because it lacks `pods/exec` in `torghut`.
- Empirical proof rows exist, are truthful, and point at dataset snapshot `torghut-full-day-20260318-884bec35`, but the
  job timestamps are from March 21 and are stale under the 86400-second freshness policy.
- Runtime profitability has 8 decisions but no execution or TCA samples in the last 72 hours.
- The latest route-exposed schema graph is current, but it still carries lineage warnings for two historical parent
  forks. That is acceptable for current readiness and still useful as a reason to keep schema proof route-based rather
  than shell-based.

Interpretation: schema health and historical artifact truthfulness are necessary, but not sufficient. Capital widening
needs fresh proof from the current runtime window or a replay quarantine that explicitly says it is counterfactual.

## Options Considered

### Option A: Keep Capital Frozen Until All Proof Jobs Are Fresh

Hold every hypothesis in shadow and do not run new decision loops until empirical proof jobs, quant-health, and runtime
profitability recover.

Pros:

- safest capital posture;
- simple operator rule;
- avoids stale proof misuse.

Cons:

- wastes market sessions while simple submission is disabled;
- produces no causal record for missed decisions;
- slows innovation because every strategy waits for batch proof;
- does not improve the proof-generation machinery.

Decision: reject. Freezing capital is correct, freezing learning is not.

### Option B: Widen Paper Capital Once Routes Are Healthy

Treat healthy `/healthz`, healthy `/db-check`, and a running scheduler as enough to re-enable paper submissions, with
empirical jobs treated as advisory.

Pros:

- restores execution samples quickly;
- easy to implement with existing flags;
- may reveal broker or TCA issues faster.

Cons:

- repeats the false-green failure mode;
- ignores stale empirical jobs and timed-out quant-health;
- can turn route liveness into capital authority;
- creates paper fills that are hard to compare with the disabled-submission decisions that came before.

Decision: reject. This is too eager for the observed proof state.

### Option C: Proof-Fresh Governor with Causal Replay Quarantine

Keep paper and live capital held until proof is fresh, but transform every planned decision into a replayable evidence
object. Use replay outcomes to rank hypotheses, then require fresh empirical jobs and action-class authorization before
paper or live widening.

Pros:

- keeps learning active without risking capital;
- turns disabled-submission periods into measurable opportunity-cost evidence;
- gives stale artifacts a safe role as historical priors, not current authority;
- aligns Torghut capital with Jangar action-class decisions;
- creates a measurable path back to paper and live execution.

Cons:

- requires a new proof object and route parity tests;
- replay is not a substitute for live fill quality;
- engineers must maintain a clear distinction between counterfactual proof and executable proof.

Decision: select Option C.

## Chosen Architecture

### ProfitProofCapsule

Torghut should persist or materialize a compact proof capsule per account, hypothesis, and window:

```text
profit_proof_capsule
  account
  hypothesis_id
  strategy_family
  release_digest
  proof_window_start
  proof_window_end
  proof_kind                 # runtime_execution, paper_execution, causal_replay, historical_empirical
  proof_freshness_state      # fresh, stale, missing, counterfactual_only
  decision_count
  execution_count
  tca_sample_count
  shadow_fill_count
  realized_pnl_proxy
  replay_pnl_proxy
  expected_net_edge_bps
  observed_slippage_bps
  max_drawdown_bps
  empirical_job_digest
  jangar_decision_digest
  capital_stage_ceiling
  blocked_reasons
  fresh_until
```

Only `runtime_execution` and `paper_execution` can widen paper or live capital. `causal_replay` can rank hypotheses,
trigger repairs, and allocate shadow replay budget, but it cannot authorize broker submission by itself.

### Causal Replay Quarantine

When submission is disabled or action-class authorization blocks a paper/live order, the scheduler should record a
quarantine event:

```text
causal_replay_quarantine_event
  planned_decision_id
  account
  hypothesis_id
  symbol
  side
  planned_at
  blocked_reason
  market_snapshot_ref
  feature_snapshot_ref
  replay_status
  replay_result_ref
```

The replay worker replays those decisions against archived market data and produces counterfactual proof. The result is
useful for hypothesis ranking and opportunity-cost analysis, but the capsule marks it `counterfactual_only` until paper
execution confirms fill and TCA behavior.

### Capital State Rules

The governor should apply these rules:

- `shadow`: allowed when the service and schema are healthy enough to record decisions or replay.
- `paper_eligible`: requires fresh Jangar action class `paper_submit=allow`, fresh empirical jobs, and a fresh capsule
  with either paper execution evidence or causal replay plus a bounded paper warmup gate.
- `live_eligible`: requires `live_submit=allow`, fresh empirical jobs, nonzero execution and TCA samples in the current
  proof window, and no rollback-required hypotheses.
- `quarantine`: required when empirical jobs are stale, quant-health times out, all hypotheses are shadow/blocked, or
  runtime profitability has zero execution/TCA samples.
- `repair`: required when route health is good but proof is stale, missing, or counterfactual-only.

For the May 5 sampled state, the expected result is:

- account `PA3SX7FYNUTF`;
- `capital_stage_ceiling=shadow`;
- `proof_freshness_state=stale`;
- `proof_kind=historical_empirical` plus `causal_replay` once new blocked decisions are replayed;
- `blocked_reasons` includes `empirical_jobs_stale`, `quant_health_timeout`, `no_runtime_execution_samples`, and
  `no_promotion_eligible_hypotheses`.

### Profitability Experiment Ladder

The governor should rank experiments by expected post-cost improvement and proof quality:

1. Repair stale proof jobs for the existing `intraday_tsmom_v1@prod` baseline.
2. Replay the last 72 hours of blocked or non-submitted decisions and compute opportunity-cost proxy.
3. Compare replay performance by hypothesis and market state, with stale March proof as a prior only.
4. Allow a bounded paper warmup for the top hypothesis only after Jangar action class `paper_submit=allow`.
5. Promote to live only after paper execution shows nonzero TCA samples, bounded slippage, and no rollback-required
   hypothesis state.

The innovation is not more aggressiveness. It is turning every blocked decision into measured counterfactual evidence
while preserving a hard boundary between counterfactual profit and executable profit.

## Validation Gates

Engineer acceptance:

- Regression test the refreshed May 5 shape: `/healthz` OK, `/readyz` 503, `/trading/health` degraded, schema current,
  stale empirical jobs, and runtime profitability with decisions but zero executions must compile to
  `capital_stage_ceiling=shadow`.
- Regression test `/trading/status`, `/trading/health`, and `/trading/profitability/runtime` agree that the sampled
  state is `shadow` or `quarantine` when empirical jobs are stale and runtime executions are zero.
- Regression test `submission_council` rejects paper/live widening when Jangar action class is missing, held, timed out,
  or blocked.
- Unit test `ProfitProofCapsule` freshness: stale empirical jobs cannot produce `paper_eligible` or `live_eligible`.
- Unit test causal replay output: counterfactual proof can rank hypotheses but cannot authorize live submission.
- Route test `/trading/empirical-jobs` stale authority is reflected in the governor blocked reasons.
- Route test that a Jangar quant-health timeout becomes typed negative proof within the route budget instead of hanging
  the Torghut capital gate.

Deployer acceptance:

- Capture `/healthz`, `/db-check`, `/trading/health`, `/trading/status`, `/trading/empirical-jobs`, and
  `/trading/profitability/runtime` for the promoted digest.
- Confirm current state produces `capital_stage_ceiling=shadow` and no paper/live widening while repair and replay stay
  available.
- Confirm blocked decisions are written to the causal replay quarantine before enabling any paper warmup.
- Confirm fresh empirical jobs and replay capsules exist before enabling paper.
- Confirm nonzero paper execution and TCA samples exist before enabling live.
- Confirm the Jangar action-class decision digest used by Torghut is fresh and has `paper_submit=allow` before paper
  warmup; `live_submit=allow` remains a separate live gate.

## Rollout Plan

1. Shadow governor: compute proof capsules and blocked reasons without changing submission behavior.
2. Quarantine recording: persist blocked planned decisions and replay references.
3. Route parity: expose the same capital ceiling and proof capsule digest from status, health, profitability, and
   scheduler diagnostics.
4. Paper enforcement: require `paper_submit=allow`, fresh empirical proof, and either paper warmup proof or bounded
   replay repair proof.
5. Live enforcement: require live action-class authorization, fresh empirical jobs, nonzero execution/TCA samples, and
   no rollback-required hypotheses.

## Rollback

Rollback must not delete proof capsules or quarantine events. Disable enforcement in this order:

1. live enforcement off, keep paper and replay diagnostics;
2. paper enforcement off, keep quarantine recording;
3. route parity enforcement off, keep proof capsule emission;
4. quarantine recording off only if it causes scheduler instability.

Rollback is successful when the service can still answer status and health, and when new decisions either execute under
the old path or record an explicit reason for not entering the proof governor.

## Risks

- Counterfactual replay can be overread as executable profit. Mitigation: capsules must mark replay
  `counterfactual_only` and capital rules must reject it for live widening.
- Strict proof freshness may delay paper restart. Mitigation: allow a bounded paper warmup only after replay and Jangar
  action-class gates pass.
- Missing privileged SQL can slow forensic validation. Mitigation: application routes and migration jobs are the
  required proof path; direct SQL is optional.
- More route parity tests increase implementation cost. Mitigation: the tests cover the actual failure mode and reduce
  future capital-risk regressions.

## Handoff

Engineer stage should implement the proof capsule builder first, then causal replay quarantine, then route parity, then
submission enforcement. Deployer stage should not widen paper or live capital until the captured production state moves
from the current quarantine result to fresh proof. The acceptance sample is the current May 5 shape: healthy liveness,
healthy schema, degraded readiness, stale empirical jobs, timed-out Jangar quant-health, 8 decisions, 0 executions, and
0 TCA samples. The expected output is a shadow capital ceiling with replay and repair allowed, paper/live held, and a
clear next action to refresh empirical jobs and replay blocked decisions.
