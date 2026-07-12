# 132. Torghut Forecast Profit Tournament And Capital Reentry Guardrails (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, PostHog hooks, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, PostHog, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `services/torghut/app/observability/posthog.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

I am selecting a **forecast profit tournament with capital reentry guardrails** as Torghut's next profitability
architecture step.

The current runtime has the raw material for learning but not the authority for capital. In the read-only sample at
`2026-05-06T19:25Z`, Torghut Postgres was reachable through the app role, Alembic was current at
`0029_whitepaper_embedding_dimension_4096`, ClickHouse `ta_microbars` and `ta_signals` were fresh to the minute, and
Torghut signal continuity reported `signals_present` with market session open. Empirical jobs were healthy in Jangar:
`benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` were eligible and fresh.

The missing piece is forecast authority. Torghut autonomy reported `enabled=false`. Its forecast service was
`status=degraded`, `authority=blocked`, `message=registry_empty`, and had no eligible model refs. Lean authority was
configured but disabled with `deterministic scaffold only`. That is the right capital block. It is not the right
learning block.

The selected design creates a zero-notional forecast tournament that uses fresh TA, empirical jobs, and Jangar
admission products to graduate models from `registry_empty` to `probation` to `eligible`. Only eligible tournament
winners can unlock paper forecast canaries, and live reentry still requires paper settlement, TCA, drawdown, reject
rate, and material action verdict gates.

The tradeoff is slower capital reentry than a route-health gate. I accept that. Torghut's profit problem is not lack of
signals; it is lack of measured, current, model-specific evidence that a forecast improves net returns after costs.

## Runtime Objective And Success Metrics

This contract increases Torghut profitability by turning the empty forecast registry into an evidence-producing
tournament instead of a permanent manual blocker.

Success means:

- `registry_empty` permits zero-notional tournament work and blocks paper/live forecast capital.
- Every candidate forecast has a model family, feature window, training data hash, prediction horizon, cost model, and
  guardrail result.
- Tournament winners beat the TA-only baseline after costs on a declared holdout window before paper canary.
- Paper canary uses bounded notional, automatic rollback, and Jangar forecast reentry admission.
- Live micro canary requires post-paper settlement and cannot be activated from forecast metrics alone.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, ClickHouse tables, or runtime objects.

### Cluster And Runtime Evidence

- Torghut namespace phase count was `Running=27` and `Completed=4`.
- Live `torghut-00242-deployment-597bfc8488-d5swx` was `2/2 Running`.
- Sim `torghut-sim-00343-deployment-594f4f889f-j2zhd` was `2/2 Running`.
- `torghut-db-1`, both ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog/enricher, websockets,
  guardrail exporters, Symphony, and Alloy were running.
- Recent events showed startup/readiness warm-up on new live and sim revisions, a whitepaper bootstrap mount error,
  and `flinkdeployment/torghut-ta-sim` `Job Not Found` while current sim TA pods were running.
- Torghut autonomy reported `enabled=false`, `last_ingest_signal_count=32`, `market_session_open=true`,
  `signal_continuity.last_state=signals_present`, and `emergency_stop_active=false`.

### Database And Data Evidence

- Torghut SQL through the app secret connected to database `torghut`.
- Public schema had `69` tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- `trade_decisions` had `147623` rows with latest created at `2026-05-06T17:44:19.618Z`.
- `position_snapshots` had `42014` rows with latest `as_of` at `2026-05-06T19:24:48.171Z`.
- `vnext_empirical_job_runs` had `20` rows with latest created at `2026-05-06T16:27:32.941Z`.
- `strategies` had `16` rows with latest updated at `2026-05-06T11:26:09.535Z`.
- ClickHouse `torghut.ta_microbars` had `1739919` rows, max event timestamp `2026-05-06 19:25:00.000`, max ingest
  timestamp `2026-05-06 19:25:00.160`, and `20` symbols.
- ClickHouse `torghut.ta_signals` had `1208172` rows, max event timestamp `2026-05-06 19:24:56.000`, max ingest
  timestamp `2026-05-06 19:24:56.656`, and `20` symbols.
- Jangar reported empirical jobs healthy and forecast service degraded with `registry_empty`.

### Source Evidence

- `services/torghut/app/trading/autonomy/lane.py` and related tests already define autonomous lane evidence and gate
  behavior.
- `services/torghut/app/trading/empirical_jobs.py` already validates empirical proof freshness, artifact refs, dataset
  refs, candidate ids, and promotion authority.
- `services/torghut/app/trading/submission_council.py` already combines dependency quorum, empirical readiness,
  Jangar quant health, policy, and capital stage. It is the right consumer for forecast reentry decisions, not the
  owner of tournament scoring.
- `services/torghut/app/trading/features.py`, ClickHouse-backed ingest, and the signal continuity route provide fresh
  feature evidence for zero-notional tournament windows.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` and the companion Jangar design define the
  cross-plane admission product Torghut must consume before forecast capital leaves shadow.

## Problem

Torghut has live signals but no forecast authority.

That is a better problem than stale data. It means the data plane can support research, but the capital plane is
correctly blocked. The risk is that we either leave the forecast registry empty indefinitely or bypass it with a manual
paper restart because core services are green. Neither path improves profitability.

The forecast registry must be repopulated by a measurable tournament:

- candidates must be comparable against a TA-only baseline;
- metrics must include net-of-cost return impact, not only classification quality;
- guardrails must block models that win by overtrading, concentrating risk, or relying on stale features;
- Jangar must admit the proof work as zero-notional until paper settlement exists.

## Alternatives Considered

### Option A: Manual Forecast Registry Seeding

Manually register one forecast model family as eligible and let the existing autonomy and submission council gates
handle paper reentry.

Pros:

- Fastest path to a non-empty registry.
- Minimal new code.
- Easy to roll back by deleting or disabling the model ref.

Cons:

- Does not prove the model improves current signal quality.
- Creates weak audit evidence for why paper capital restarted.
- Can bypass the fresh empirical job and Jangar admission surfaces.
- Encourages model registry writes as an operational fix rather than an evidence outcome.

Decision: reject.

### Option B: Keep Autonomy Disabled Until Full Lean Authority Is Ready

Treat forecast work as blocked until Lean authority moves beyond deterministic scaffold mode.

Pros:

- Strong safety.
- Avoids a second tournament lane.
- Keeps paper/live capital blocked until simulation authority is richer.

Cons:

- Wastes fresh TA and empirical job evidence.
- Does not reduce the forecast registry gap.
- Couples forecast model readiness to a separate Lean maturity milestone.
- Leaves Torghut with no measurable path from current data to improved profit hypotheses.

Decision: reject.

### Option C: Forecast Profit Tournament With Capital Reentry Guardrails

Run zero-notional forecast tournaments against declared symbol sets and windows. Graduate winners only after measured
profit and risk gates pass.

Pros:

- Converts `registry_empty` into actionable proof work.
- Uses the fresh ClickHouse and empirical job surfaces without spending capital.
- Produces model-specific audit evidence.
- Keeps paper/live reentry behind Jangar material action verdicts and Torghut submission council gates.
- Lets Lean authority stay scaffold-only while forecast learning proceeds in observe mode.

Cons:

- Adds tournament artifacts and model registry states.
- Requires careful cost accounting to avoid promoting high-turnover false positives.
- Requires data leakage and lookahead checks before any model can be considered eligible.

Decision: select Option C.

## Architecture

Torghut emits forecast tournament products.

```text
forecast_tournament_run
  tournament_id
  generated_at
  symbol_set
  account_label
  prediction_horizon
  training_window
  holdout_window
  feature_contract_hash
  data_snapshot_refs
  baseline_ref
  candidate_results
  guardrail_results
  winning_model_ref
  registry_decision       # remain_empty, probation, eligible, revoke
  jangar_admission_ref
```

Candidate result:

```text
forecast_candidate_result
  model_ref
  model_family            # chronos, financial_tsfm, moment, linear_baseline, tree_baseline
  training_data_hash
  feature_version
  horizon
  brier_score
  log_loss
  directional_hit_rate
  information_coefficient
  net_return_bps
  turnover
  slippage_bps
  reject_rate
  max_drawdown
  calibration_error
  leakage_checks
  verdict                 # reject, probation, eligible
```

Model registry states:

- `empty`: no eligible forecast authority; observe tournaments allowed, capital blocked.
- `probation`: one or more candidates beat the baseline but require paper shadow settlement.
- `eligible`: candidate passes tournament, paper settlement, and policy guardrails.
- `stale`: candidate evidence expired.
- `revoked`: candidate failed rollback, drift, or safety checks.

Capital behavior:

- `observe`: max notional `0`; allowed when TA freshness, empirical jobs, and Jangar forecast admission are healthy.
- `paper_canary`: max notional set by policy; requires probation or eligible forecast model, paper route health,
  no emergency stop, signal continuity, and no terminal-run admission block.
- `live_micro_canary`: requires eligible model, paper settlement, TCA, reject-rate, drawdown, and material action
  verdict allow.
- `live_scale`: requires live micro settlement and explicit deployer approval.

## Measurable Trading Hypotheses

H-FPT-01, forecast-filtered TA improves net paper returns:

- Baseline: current TA-only scheduler on the same symbols and decision horizon.
- Candidate: forecast model filters or sizes TA decisions when predicted next-window edge exceeds threshold.
- Primary metric: net return bps after slippage and reject costs.
- Secondary metrics: hit rate, information coefficient, turnover, max drawdown, reject rate, and calibration error.
- Promotion gate: candidate beats baseline by at least `15` net bps over the holdout window, has max drawdown under
  `3%`, reject rate under `2%`, and no leakage check failure.

H-FPT-02, forecast confidence should reduce false positives during high churn:

- Baseline: TA decisions during high-turnover windows.
- Candidate: confidence threshold or no-trade band derived from tournament calibration.
- Primary metric: reduction in losing trades per hour without reducing positive net return.
- Promotion gate: at least `20%` false-positive reduction, no more than `10%` reduction in profitable opportunities,
  and lower realized slippage than baseline.

H-FPT-03, model eligibility decays faster than data freshness:

- Baseline: keep last eligible forecast model until data freshness fails.
- Candidate: expire eligibility on calibration drift or paper settlement failure even when TA data is fresh.
- Primary metric: drawdown avoided after calibration drift.
- Promotion gate: drift expiry prevents a paper drawdown breach in replay and does not block more than one valid
  profitable session in the holdout.

## Guardrails

Hard guardrails:

- No paper or live forecast capital while registry state is `empty`.
- No live forecast capital while autonomy is disabled, unless the submission council explicitly treats the lane as
  paper-only.
- No promotion if any leakage check, feature freshness check, or account scope check fails.
- No model can be eligible without a training data hash, holdout window, and cost model.
- No live micro canary without paper settlement and Jangar material action verdict allow.

Soft guardrails:

- Degrade to observe when ClickHouse max event timestamp is older than the configured TA freshness window.
- Degrade to observe when empirical job evidence is stale or ineligible.
- Degrade to observe when terminal run settlement blocks normal dispatch.
- Prefer lower-turnover models when net return ties within `5` bps.

## Implementation Scope

Engineer stage:

- Add forecast tournament product schemas and pure validators in Torghut.
- Add an offline tournament runner that consumes ClickHouse-backed features and produces compact product artifacts.
- Add model registry states without enabling capital by default.
- Extend autonomy/submission council consumers to understand `empty`, `probation`, `eligible`, `stale`, and `revoked`.
- Add tests for registry-empty observe, probation paper hold, eligible paper canary, stale revocation, and leakage
  failure.

Deployer stage:

- Run the first tournament in zero-notional mode against the active `20`-symbol TA universe.
- Confirm Jangar forecast reentry admission is present and permits observe only.
- Keep `TRADING_AUTONOMY_ENABLED=false` for live capital until paper canary settlement exists.
- Publish tournament refs, model refs, and guardrail results before any paper route change.

## Validation Gates

Required local checks:

- Torghut forecast tournament unit tests once implemented.
- Torghut submission council tests for forecast registry state transitions.
- Jangar material action verdict tests for `forecast_reentry`.
- Documentation check for this design and the companion Jangar design.

Required runtime checks before paper:

- Torghut `/trading/autonomy` shows fresh signal continuity and no emergency stop.
- ClickHouse `ta_microbars` and `ta_signals` max event timestamps are within the freshness window.
- Jangar empirical services report fresh empirical jobs.
- Forecast tournament product exists with a non-empty candidate result set.
- Jangar forecast reentry admission product reports paper canary allowed.

Required runtime checks before live micro:

- Paper canary settlement is complete.
- TCA and reject-rate guardrails pass.
- Drawdown stays under policy threshold.
- Jangar material action verdict reports live micro allow.
- Deployer confirms rollback target and emergency stop state.

## Rollout

1. `registry_empty` observe: run tournaments with no notional and no registry eligibility.
2. Probation: write model refs as probation only after baseline-beating holdout evidence.
3. Paper canary: allow bounded paper only after Jangar admission and submission council agree.
4. Live micro: allow only after paper settlement, TCA, and drawdown gates pass.
5. Live scale: require explicit deployer approval and sustained live micro proof.

## Rollback

- Set registry state to `revoked` for the model ref.
- Keep `TRADING_AUTONOMY_ENABLED=false` for live capital.
- Keep forecast lane in observe mode while retaining tournament products for audit.
- If a model causes paper drawdown or reject-rate breach, block future paper until a new tournament beats the baseline
  after excluding the failed feature set.
- If Jangar forecast admission is unavailable, hold paper/live capital and allow only zero-notional data collection.

## Risks

- A forecast model can overfit one active market regime unless holdout windows are session-scoped and replayed.
- Cost models can understate slippage during high churn.
- Options data tables are currently empty, so options-informed forecast work must stay behind a cold-start fuse.
- Tournament jobs can increase database and ClickHouse load if they do not use bounded windows and compact artifacts.

## Handoff Contract

Engineer:

- Implement schemas, validators, and tests before any route or scheduler integration.
- Treat `registry_empty` as observe-only, not as an exception path.
- Bind every candidate to symbol set, account, horizon, data hash, and guardrail results.
- Do not introduce live capital behavior in the forecast tournament implementation.

Deployer:

- Do not enable paper forecast capital until Jangar forecast reentry admission and Torghut tournament products both
  allow it.
- Keep live capital disabled until paper settlement and TCA evidence are posted.
- Roll back by revoking the model ref and leaving the lane in observe mode.
