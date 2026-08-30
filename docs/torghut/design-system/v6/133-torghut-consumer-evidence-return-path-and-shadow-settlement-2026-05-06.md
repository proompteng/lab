# 133. Torghut Consumer Evidence Return Path And Shadow Settlement (2026-05-06)

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

I am selecting a **consumer evidence return path with shadow settlement** as the next Torghut architecture contract.

The current state is better than the May 5 degraded snapshot, but it is not ready for paper or live capital widening.
On 2026-05-06 at about 20:13 UTC, live Torghut `torghut-00243` and sim `torghut-sim-00344` were running at commit
`62b9efedb1366c24f0b44b42923099d38249c47c` and image digest
`sha256:34de81692a3645864cb94deec58950b97c860acce7a3bf5313de47eff95ee08c`. Jangar reported healthy leader election,
agents-controller, workflow runtime, job runtime, execution trust, database migrations, watch reliability, NATS runtime
kit, and rollout health. Postgres connected read-only as `torghut_app`, Alembic was current at
`0029_whitepaper_embedding_dimension_4096`, and the ClickHouse guardrails exporter showed both replicas fresh and not
read-only.

The problem is now proof asymmetry. Jangar can issue material-action receipts, but its current paper and live Torghut
receipts still hold on `torghut_consumer_evidence_missing` and `forecast_service_degraded`. Torghut live has healthy
core dependencies, but live `/readyz` remains degraded because `simple_submit_disabled` correctly blocks the
live-submission gate. Live quant health is `quant_health_not_configured`. Torghut sim is route-ready, but scoped sim
quant health is degraded with `quant_latest_metrics_empty`, and sim empirical jobs are missing. Source and database
state also show settlement debt: `executions` and `execution_tca_metrics` are last updated on 2026-04-03 while current
trade decisions and position snapshots are fresh.

The selected design makes Torghut return a signed, typed consumer evidence receipt to Jangar for every observe, paper,
and live action class. That receipt is not a permission slip. It is a structured statement of what Torghut actually
knows: active revision, source commit, schema head, ClickHouse freshness, signal state, hypothesis blockers, empirical
jobs, TCA settlement recency, scoped quant state, forecast state, and rollback target. Jangar can then replace
`torghut_consumer_evidence_missing` with precise blockers and deployers can validate the system without hand-joining
routes, pods, and SQL.

The tradeoff is one more payload and one more storage path before paper canary widening. I accept that cost. Torghut
does not need faster capital right now; it needs capital gates that can distinguish fresh observe evidence from stale
settlement and missing forecast authority.

## Runtime Objective And Success Metrics

This contract increases profitability by turning the current shadow runtime into an evidence-producing settlement
system. It also improves Jangar reliability by closing the consumer acknowledgment gap behind material-action receipts.

Success means:

- Jangar no longer reports `torghut_consumer_evidence_missing` after Torghut emits a current receipt for the action
  class.
- Paper remains held while sim scoped quant metrics are empty, sim empirical jobs are missing, or forecast service is
  `registry_empty`.
- Live remains blocked while `TRADING_SIMPLE_SUBMIT_ENABLED=false`, live quant is not configured, or paper settlement
  is absent.
- Every Torghut receipt names the source commit, active live/sim revision, Alembic head, ClickHouse freshness, account,
  hypothesis ids, empirical job refs, and rollback target.
- Engineer and deployer stages can validate the receipt path with route probes, Postgres read-only queries, guardrail
  metrics, and Jangar material-action receipt changes.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, ClickHouse tables, or runtime objects.

### Cluster And Rollout Evidence

- `kubectl config current-context` was initially unset; I bootstrapped the in-cluster service-account context for
  read-only inspection.
- `deployment/jangar` was `1/1`, `deployment/agents` was `1/1`, and `deployment/agents-controllers` was `2/2`.
- Jangar status reported healthy leader election, agents/supporting/orchestration controllers, workflow/job/Temporal
  runtime adapters, execution trust, database migration consistency, watch reliability, runtime kits, and rollout
  health.
- Torghut namespace had live `torghut-00243-deployment-dd8ff7496-h9r9n` and sim
  `torghut-sim-00344-deployment-68787fcc66-rmdp5` running `2/2`.
- ClickHouse replicas, Keeper, Postgres, live TA, sim TA, options TA, options catalog, options enricher, websocket
  forwarders, guardrail exporters, Alloy, and Symphony were running.
- Recent Torghut events showed transient startup/readiness probe timeouts during live/sim rollout, followed by
  `RevisionReady` for `torghut-00243` and `torghut-sim-00344`.
- Torghut events still repeat `MultiplePodDisruptionBudgets` warnings for ClickHouse pods, which is rollout hygiene
  debt for the deployer lane.
- Argo Workflows showed many recent `torghut-historical-simulation-*` pods in `Error`, so historical proof generation
  remains unreliable even while current runtime pods are healthy.

### Route Evidence

- Live `/healthz` returned `{"status":"ok","service":"torghut"}`.
- Live `/readyz` returned `status=degraded`: Postgres, ClickHouse, Alpaca, database schema, universe, empirical jobs,
  DSPy runtime, and quant evidence were non-failing, but `live_submission_gate.ok=false` with
  `simple_submit_disabled`.
- Live `/trading/status` reported `mode=live`, `pipeline_mode=simple`, `autonomy_enabled=false`,
  `simple_lane.submit_enabled=false`, `capital_stage=shadow`, `forecast_service.status=degraded`,
  `forecast_service.message=registry_empty`, `quant_evidence.reason=quant_health_not_configured`, and
  `empirical_jobs.ready=true`.
- Live alpha readiness had three source hypotheses, `state_totals={blocked:1, shadow:2}`, and
  `promotion_eligible_total=0`.
- Sim `/readyz` returned `status=ok`, but sim quant evidence was degraded with `quant_latest_metrics_empty`,
  `latest_metrics_count=0`, and missing pipeline stages.
- Sim `/trading/status` reported paper mode, `simple_lane.submit_enabled=true`, empirical jobs missing, forecast
  registry empty, and the same three hypotheses with zero promotion eligibility.
- Jangar material-action receipts allowed observe work but held paper and live micro canary on
  `torghut_consumer_evidence_missing` and `forecast_service_degraded`; live scale was blocked by
  `paper_settlement_required` and forecast degradation.

### Database And Data Evidence

- Postgres read-only SQL connected to database `torghut` as `torghut_app`.
- `alembic_version` was `0029_whitepaper_embedding_dimension_4096`.
- `pg_stat_user_tables` estimated `torghut_options_contract_catalog` at about 2.39M rows with 282K dead tuples,
  options subscription state at about 6K rows with 19K dead tuples, and options watermarks at about 5K rows.
- Exact freshness probes showed `position_snapshots` fresh through `2026-05-06T20:11:41Z` and `trade_cursor` updated
  at `2026-05-06T20:11:42Z`.
- `trade_decisions` had 147,623 rows with latest created at `2026-05-06T17:44:19Z`.
- `vnext_empirical_job_runs` had 20 rows with latest updated at `2026-05-06T16:27:32Z`.
- `executions` had 13,778 rows and `execution_tca_metrics` had 13,775 rows, both last updated on 2026-04-03; this is
  stale for capital settlement even though the TCA summary is still visible in live status.
- ClickHouse guardrails reported both replicas up, not read-only, free disk ratio above 96%, `ta_signals` fresh through
  `2026-05-06T20:11:00Z`, and `ta_microbars` fresh through `2026-05-06T20:09:06Z`.
- Direct ClickHouse auth from this workspace failed for the app user, while the guardrail exporter succeeded. That
  makes the exporter and runtime route the least-privilege evidence source for deployer validation unless credentials
  are repaired separately.

### Source Evidence

- `services/torghut/app/main.py` is a 4,051-line control surface that mixes readiness, runtime status, health, and
  trading route assembly. It already exposes most receipt inputs but does not yet publish them as a durable consumer
  receipt.
- `services/torghut/app/config.py` is 2,965 lines and already contains toggles for Jangar control-plane status, quant
  health, empirical jobs, readiness caching, and evidence continuity.
- `services/torghut/app/trading/submission_council.py` composes dependency quorum, empirical readiness, quant
  evidence, alpha readiness, and live submission gates. It is the right place to consume a Jangar material-action
  verdict and produce a Torghut consumer receipt summary.
- `services/torghut/app/trading/empirical_jobs.py` validates empirical job truthfulness, lineage, and freshness, but
  sim currently lacks the scoped empirical jobs required for paper capital.
- `services/torghut/app/trading/hypotheses.py` compiles source-defined hypothesis readiness. The missing surface is a
  durable per-action receipt that Jangar can acknowledge.
- The Torghut test tree has 140 `test_*.py` files, including coverage for submission council, hypotheses, empirical
  jobs, signal ingest, trading API, and historical simulation. The gap is a cross-plane test proving that a missing
  consumer receipt becomes a precise Jangar blocker and never widens capital by route health alone.

## Problem

Torghut and Jangar now have enough evidence to be safe, but not enough shared evidence to be profitable.

The current failure mode is subtle:

1. Jangar sees healthy control-plane dependencies and can issue material-action receipts.
2. Torghut sees healthy core runtime dependencies and can keep live and sim services ready.
3. Paper and live material actions still hold because Jangar cannot see Torghut's scoped consumer evidence.
4. Sim evidence is incomplete even though the sim service is route-ready.
5. Live evidence is intentionally capital-blocked, but the block is expressed as a route gate rather than as a durable
   settlement receipt.

That split encourages manual interpretation. Manual interpretation is exactly what loses money in an autonomous
trading stack. A deployer should not need to read live status JSON, sim status JSON, Jangar material-action receipts,
Postgres freshness, ClickHouse exporter metrics, and Argo workflow pods to answer whether paper canary is allowed.

## Alternatives Considered

### Option A: Configure Forecast And Quant URLs First

Wire the missing live quant URL, seed the forecast registry, and let the existing submission council decide paper/live
admission.

Pros:

- Shortest path to removing two visible blockers.
- Uses existing route fields.
- Does not add persistence before the next implement lane.

Cons:

- Does not close `torghut_consumer_evidence_missing`.
- Can turn a missing evidence problem into a stale evidence problem.
- Does not explain sim empirical job absence or historical simulation errors.
- Does not give Jangar an acknowledgment that Torghut consumed the verdict.

Decision: reject as the primary architecture. It remains an engineer task inside the selected design.

### Option B: Let Jangar Poll Every Torghut Detail Directly

Make Jangar scrape Torghut live/sim status, Postgres freshness, ClickHouse freshness, and workflow state, then compute
paper/live verdicts without a Torghut-authored receipt.

Pros:

- Centralizes material-action truth.
- Avoids a Torghut writer path.
- Gives Jangar a wide validation surface.

Cons:

- Couples Jangar to Torghut internals and route shapes.
- Requires broader credentials or fragile scraping.
- Makes Torghut a passive subject even though Torghut owns capital semantics.
- Does not prove Torghut accepted the verdict before acting.

Decision: reject.

### Option C: Torghut Consumer Evidence Return Path With Shadow Settlement

Torghut emits a typed receipt for each action class. Jangar stores it, reconciles it with material-action receipts, and
returns precise blocks for observe, paper, live micro, and live scale.

Pros:

- Closes the missing consumer evidence loop.
- Keeps Jangar responsible for control-plane truth and Torghut responsible for capital truth.
- Lets observe and repair continue while paper/live stay held.
- Produces a durable audit trail for every hypothesis and action class.
- Turns vague paper/live holds into specific repair work: scoped quant metrics, sim empirical jobs, forecast registry,
  TCA settlement recency, and rollout hygiene.

Cons:

- Adds one payload, route, and persistence table.
- Requires careful TTLs to avoid stale receipts during rapid rollout.
- Requires new tests across Torghut and Jangar rather than isolated route tests.

Decision: select Option C.

## Architecture

Torghut emits one receipt per account, revision, action class, and evidence window.

```text
torghut_consumer_evidence_receipt
  receipt_id
  generated_at
  expires_at
  account_label
  action_class              # torghut_observe, paper_canary, live_micro_canary, live_scale
  runtime_mode              # live or paper
  active_revision
  source_commit
  image_digest
  alembic_head
  jangar_material_action_verdict_id
  dependency_quorum_decision
  clickhouse_freshness_ref
  postgres_freshness_ref
  hypothesis_evidence
  empirical_job_evidence
  quant_evidence
  forecast_evidence
  tca_settlement_evidence
  rollout_evidence
  decision                  # allow_observe, hold_paper, hold_live, block_live, repair_only
  reason_codes
  rollback_target
```

Hypothesis evidence must include:

```text
hypothesis_evidence
  hypothesis_id
  strategy_family
  state
  capital_stage
  promotion_eligible
  rollback_required
  observed_signal_lag_seconds
  feature_batch_rows_total
  drift_detection_checks_total
  market_context_freshness_seconds
  tca_order_count
  avg_abs_slippage_bps
  post_cost_expectancy_bps_proxy
  reasons
```

The receipt decision rules are conservative:

- `torghut_observe` may be `allow_observe` when Jangar control-plane receipt is current, Torghut route is healthy, and
  Postgres/ClickHouse freshness is current.
- `paper_canary` must hold if sim scoped quant metrics are empty, sim empirical jobs are missing, forecast registry is
  empty, or the target hypothesis lacks enough fresh signal and feature evidence.
- `live_micro_canary` must hold if paper settlement is absent, live quant is not configured, `simple_submit_enabled`
  is false, or TCA settlement is stale.
- `live_scale` must block until live micro canary has settled, paper evidence is current, forecast authority is
  eligible, and rollback rehearsal is present.

## Implementation Scope

Engineer stage:

- Add a Torghut receipt builder around the existing submission council, hypothesis readiness, empirical job status,
  quant evidence, forecast status, TCA summary, and readiness dependency snapshot.
- Expose `GET /trading/control-plane/consumer-evidence` for read-only receipt inspection.
- Add optional `POST` or outbox publishing to Jangar only when `TRADING_CONSUMER_EVIDENCE_RETURN_ENABLED=true`.
- Add a persistence table for the last N receipts per account/action class, with TTL and source revision fields.
- Add tests that prove stale receipts cannot satisfy paper/live gates and that `simple_submit_disabled` remains a live
  blocker even when Jangar is healthy.

Jangar stage:

- Store Torghut receipts keyed by action class and account.
- Reconcile material-action receipts with the latest Torghut consumer receipt.
- Replace `torghut_consumer_evidence_missing` with exact reason codes when a current receipt exists.
- Keep paper/live decisions in hold/block unless forecast, scoped quant, empirical, and settlement evidence pass.

Deployer stage:

- Deploy with receipt emission disabled first and route inspection only.
- Enable shadow receipt generation for `torghut_observe`.
- Enable Jangar ingestion in shadow mode and verify receipt freshness.
- Only then allow paper canary verdicts to use the receipt, still with zero live notional.

## Validation Gates

Required local checks for code implementation:

- `uv sync --frozen --extra dev`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- Targeted Torghut tests for receipt builder, submission council, hypotheses, empirical jobs, and trading API.
- Targeted Jangar tests for material-action receipt reconciliation and stale receipt TTL handling.

Required deployer checks:

- `kubectl get pods -n torghut -o wide` shows live, sim, Postgres, ClickHouse, TA, options, and exporters running.
- `curl http://torghut.torghut.svc.cluster.local/trading/control-plane/consumer-evidence` returns a current observe
  receipt for live and sim.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` no longer reports
  `torghut_consumer_evidence_missing` when a current Torghut observe receipt exists.
- Live `/readyz` may remain degraded on `simple_submit_disabled`; that is expected until live submission is explicitly
  enabled by a separate rollout.
- Sim paper cannot become admissible while scoped quant metrics are empty or empirical jobs are missing.
- Historical simulation workflow errors are not allowed to be ignored for paper/live proof; they must be cited as
  `simulation_proof_unsettled`.

## Rollout

Phase 0 is documentation and handoff only. No runtime flags or manifests change in this PR.

Phase 1 adds Torghut receipt generation behind `TRADING_CONSUMER_EVIDENCE_RETURN_ENABLED=false` and exposes the local
read-only route. No Jangar ingestion and no capital effect.

Phase 2 enables Jangar ingestion in shadow mode. Jangar records receipts and reports what would change, but material
action decisions remain exactly as today.

Phase 3 allows Jangar to replace `torghut_consumer_evidence_missing` with precise receipt-derived blockers for observe
and repair only. Paper and live remain held.

Phase 4 allows paper canary admission to consume receipts after sim scoped quant, sim empirical jobs, forecast
tournament, and TCA settlement gates pass.

Phase 5 considers live micro canary only after paper settlement and rollback rehearsal are current.

## Rollback

Rollback is deliberately simple:

- Disable `TRADING_CONSUMER_EVIDENCE_RETURN_ENABLED`.
- Disable Jangar consumer receipt ingestion or force it back to shadow.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false`, `TRADING_AUTONOMY_ENABLED=false`, and
  `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`.
- Revert to existing Jangar material-action receipts and Torghut readiness gates.
- Treat any stale receipt as expired immediately during rollback.

No rollback step requires database deletion. Receipts are append-only audit records and can expire naturally.

## Risks

- Receipt staleness can create false confidence if TTLs are too long. Default TTL should be short, tied to active
  revision, and invalidated on source commit or image digest change.
- The receipt builder could grow into another monolith inside `main.py`; implementation should isolate it under
  `app/trading/control_plane/consumer_evidence.py`.
- The current direct ClickHouse credential mismatch needs a separate operational repair or the deployer must rely on
  exporter/runtime route evidence.
- Historical simulation workflow errors are still a hard proof risk. The receipt path must not hide those failures.
- Options catalog dead tuples are operational debt. They do not block observe receipts, but they should be watched
  before options-driven paper widening.

## Engineer Handoff

Build the receipt path as a shadow-only feature. The first implementation is successful when Torghut can produce a
current observe receipt for live and sim, Jangar can store it, and Jangar can show that paper/live are still held for
specific reasons. Do not enable paper or live capital as part of the first implementation.

Acceptance gates:

- Current observe receipts exist for `torghut-00243` or later and `torghut-sim-00344` or later.
- Receipt source commit matches the running `TORGHUT_COMMIT`.
- Receipt Alembic head equals `0029_whitepaper_embedding_dimension_4096` or the then-current expected head.
- Receipt records live `simple_submit_disabled` and live `quant_health_not_configured`.
- Receipt records sim `quant_latest_metrics_empty` and missing empirical jobs until repaired.
- Jangar material-action status no longer has a generic missing-consumer blocker when a current observe receipt exists.

## Deployer Handoff

Deploy in shadow mode only. The deployer should prove that receipt generation follows rollout changes and expires on
stale revisions. Paper canary is a later promotion and must not be inferred from a green route.

Deployment gates:

- Pod/deployment readiness is green for Jangar, agents, Torghut live, Torghut sim, Postgres, ClickHouse, and guardrail
  exporters.
- Jangar status remains healthy for control runtime, dependency quorum, watch stream, NATS runtime kit, and database
  migrations.
- Torghut live remains shadow with live submission disabled unless a separate approved rollout changes it.
- Sim paper remains held until scoped quant and empirical jobs are repaired.
- Rollback drill confirms disabling the receipt flag returns Jangar to the previous missing-consumer behavior without
  widening action classes.
