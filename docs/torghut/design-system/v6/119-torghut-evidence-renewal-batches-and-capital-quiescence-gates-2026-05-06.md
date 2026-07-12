# 119. Torghut Evidence Renewal Batches And Capital Quiescence Gates (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

Torghut will publish **evidence-renewal batches** and consume Jangar watch quiescence before any paper or live capital
readmission.

The current Torghut state is a good example of why a simple readiness bit is insufficient. The service is deployed,
the current live revision is available, and `/db-check` says the schema is current with graph lineage ready. At the
same time, Argo CD reports Torghut `OutOfSync`, `/readyz` returns HTTP `503` with `database unavailable`,
`/trading/health` returns HTTP `503`, live submission is disabled, quant health is not configured as a required live
route proof, empirical jobs are stale, the live account quant latest store is stale, the sim account latest store is
empty, market context is down, and there are `199` open quant alerts.

That is not a trade/no-trade decision. It is a repair-ranking problem under a Jangar material-action hold. Torghut
needs to spend runtime and query budget on repairs that renew profit evidence, while Jangar requires watch quiescence
before treating those repairs as capital-grade.

The selected design groups repairs into `torghut_evidence_renewal_batch` records. A batch names the stale evidence it
will renew, the hypothesis or strategy it can unlock, the maximum runtime/query spend, the notional ceiling, the Jangar
watch quiescence epoch it depends on, and the closure receipt required for paper or live readmission. This keeps repair
moving while capital remains at zero.

The tradeoff is slower capital readmission. I accept that. Profitability comes from fresh, falsifiable proof under
known control-plane conditions, not from racing back to paper or live routes while the watch fabric and proof stores are
still stale.

## Evidence Snapshot

All checks were read-only.

### Runtime And Data Evidence

- Argo CD reported `torghut` as `OutOfSync` and `Healthy` at revision
  `f15d5b1fd8be1e61c053bf9bdaeeace397d77ff3`.
- The live Knative revision `torghut-00236` was available on image
  `registry.ide-newton.ts.net/lab/torghut@sha256:42585d333a948474a3c382c2f088a99d92a702a0aa938a4329331487955d7fef`.
- The sim revision `torghut-sim-00322` was available on image
  `registry.ide-newton.ts.net/lab/torghut@sha256:705a6de960473d5945c3ad1528f359d259f5229c8146724ae20212b16b419623`.
- Torghut options catalog, options enricher, TA, TA sim, websocket, websocket options, ClickHouse exporters, Alloy, and
  Symphony workloads were running.
- Recent events showed sim rollout churn, readiness and startup probe misses, duplicate ClickHouse PDB matches, and
  Keeper PDB `NoPods`.
- `/db-check` returned HTTP `200`, `ok=true`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`.
- `/readyz` returned HTTP `503` with `database unavailable`.
- `/trading/health` returned HTTP `503`; live submission was blocked by `simple_submit_disabled`.
- Quant evidence in `/trading/health` was `not_required` and informational because `quant_health_not_configured`.
- `/trading/autonomy` reported stale empirical jobs: `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- The stale empirical jobs were all for `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.
- Jangar live-account quant health returned `status=ok`, `latestMetricsCount=108`,
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`, and `metricsPipelineLagSeconds=67329`.
- Jangar sim-account quant health returned `status=degraded`, `latestMetricsCount=0`, and
  `emptyLatestStoreAlarm=true`.
- Jangar market-context health for `AAPL` returned `overallState=down`; ClickHouse ingestion reported
  `CH_HOST is not configured`, technicals and regime were `error`, and fundamentals/news were `missing`.
- Jangar quant alerts returned `199` open alerts, including `105` critical alerts.
- Direct CNPG `psql` probes were forbidden by service-account RBAC, so routine validation must use service-owned
  projections unless a deployer runs a higher-privilege read-only check.

### Jangar Coupling Evidence

- Jangar and Agents were serving HTTP `200` and schema-current.
- Jangar watch reliability was `degraded` with `1075` restarts over 15 minutes and no watch errors.
- Jangar dependency quorum blocked on `watch_reliability_blocked`.
- Jangar runtime admission passports still allowed serving and swarm stages, so zero-notional repair can continue while
  material action waits for quiescence.
- The companion Jangar contract defines `watch_quiescence_epoch` and `evidence_renewal_window` receipts.

### Source Evidence

- `services/torghut/app/main.py` owns readiness, DB checks, trading health, autonomy status, decisions, executions, and
  data projections. It should expose renewal-batch status, not compute Jangar watch authority.
- `services/torghut/app/trading/submission_council.py` already loads typed Jangar quant health and is the right place
  to require renewal receipts before sizing or submission.
- `services/torghut/app/trading/scheduler/pipeline.py` owns market-context observations, signal continuity, rejection
  accounting, LLM decision context, and order preparation. It should produce repair bids and renewal-batch closure
  receipts.
- `services/torghut/config/trading/hypotheses/*.json` gives Torghut a lane-local place to bind renewal work to a
  hypothesis, candidate, account, strategy, and guardrail set.
- Existing tests cover trading health, autonomy, scheduler safety, submission council, DB checks, market context, and
  quant readiness. The missing system-level test is batch-level proof renewal under a Jangar watch-quiescence hold.

## Problem

Torghut has several stale or incomplete proof surfaces:

1. Empirical promotion jobs are stale by more than one month.
2. The live route does not require typed Jangar quant health.
3. Live-account quant metrics are routable but stale.
4. Sim-account quant metrics are empty.
5. Market context is down because ClickHouse ingestion is unconfigured and provider domains are missing or errored.
6. Torghut desired state is OutOfSync.
7. Open quant alerts are high enough that capital readmission needs an explicit closure plan.

Running every repair independently creates a queue, not a capital argument. A capital argument needs to say which
hypothesis is being renewed, which stale evidence is retired, which Jangar quiescence epoch was active, and which
guardrail prevents the repair from becoming live risk.

## Alternatives Considered

### Option A: Wait For Everything To Be Green, Then Reopen Capital

Pros:

- Operationally simple.
- Conservative for live notional.
- Avoids building another coordination contract.

Cons:

- Does not rank repairs by expected profit value.
- Can leave stale empirical jobs and market context unattended while the system waits for unrelated rollout cleanup.
- Gives no durable receipt explaining why capital was readmitted.

Decision: reject. It is safe but too passive for a profitability system.

### Option B: Run A Fixed Repair Sequence

Pros:

- Easy to schedule: empirical replay, quant backfill, sim bootstrap, market context, GitOps convergence, alert cleanup.
- Easier to test than dynamic ranking.
- Better than waiting for all-green readiness.

Cons:

- Wastes scarce runtime/query budget on low-value repairs.
- Does not account for the active Jangar watch-quiescence hold.
- Does not bind repair work to specific hypotheses or capital gates.

Decision: reject as the target. Use it only as fallback if batch ranking cannot be computed.

### Option C: Evidence-Renewal Batches Gated By Watch Quiescence

Pros:

- Converts stale proof into ranked, auditable repair batches.
- Keeps maximum notional at `0` while the Jangar watch fabric is warming.
- Links every repair to a hypothesis, candidate, guardrail, and closure receipt.
- Lets Torghut optimize for expected information gain and future profit instead of generic cleanup.
- Gives Jangar a concrete consumer receipt before paper or live capital readmission.

Cons:

- Requires a new batch record and closure receipt schema.
- Requires scheduler and submission-council changes.
- Requires care so expected profit value is never treated as realized PnL.

Decision: select Option C.

## Architecture

Torghut emits `torghut_evidence_renewal_batch` records.

```text
torghut_evidence_renewal_batch
  batch_id
  created_at
  expires_at
  jangar_watch_quiescence_epoch_id
  jangar_evidence_renewal_window_id
  hypothesis_id
  candidate_id
  account
  strategy_id
  market_session_id
  renewal_lanes              # empirical, live_quant, sim_quant, market_context, gitops, alert_closure
  stale_evidence_refs
  expected_information_gain
  expected_profit_value      # low, medium, high, critical
  capital_gate_unlocked      # observe, paper_canary, live_micro_canary, live_scale
  max_runtime_minutes
  max_query_budget
  max_notional
  guardrails
  decision                   # proposed, running, complete, rejected, expired
  closure_receipt_refs
```

Closure receipts are lane-specific:

- `empirical_replay_receipt`: current dataset, artifact refs, pass/fail gates, candidate id, created_at freshness.
- `live_quant_receipt`: typed Jangar health URL, account/window, latest metrics count, lag threshold, alert delta.
- `sim_quant_receipt`: non-empty sim latest store, account/window, parity with live schema.
- `market_context_receipt`: symbol set, domain states, ClickHouse/provider configuration, freshness thresholds.
- `gitops_convergence_receipt`: Argo sync revision, health, drift refs closed.
- `alert_closure_receipt`: alert ids resolved or explicitly carried as bounded debt.

Capital gates:

- `observe`: allowed with zero notional when the batch is valid and Jangar serving is healthy.
- `paper_canary`: requires Jangar watch quiescence, DB readiness, fresh empirical receipt, quant receipt, and no critical
  unresolved alerts for the candidate scope.
- `live_micro_canary`: requires paper canary closure plus live submission enabled by GitOps and a clean market-context
  receipt.
- `live_scale`: requires multiple market-session receipts and owner-approved capital stage graduation.

## Measurable Hypotheses

Hypothesis 1:

- If stale empirical jobs for `intraday_tsmom_v1@prod` are replayed on a current dataset and attached to a renewal
  batch, Jangar dependency quorum can stop treating empirical evidence as stale for that candidate once watch
  quiescence is also present.
- Success metric: all four empirical jobs fresh within one market session and referenced by a batch closure receipt.
- Guardrail: max notional `0`; no paper or live orders from empirical replay.

Hypothesis 2:

- If live typed quant health is configured as a required route proof and the live account/window latest store is
  refreshed, the route can stop treating quant proof as informational only.
- Success metric: `/trading/health` cites a source URL, live account/window lag stays below threshold, and scoped open
  quant alerts fall by at least `50%` or are carried as explicit debt.
- Guardrail: live submission stays disabled until Jangar allows at least `paper_canary`.

Hypothesis 3:

- If sim-account latest metrics are bootstrapped before paper canary, paper eligibility will rely on comparable live
  and sim proof instead of a live-only projection.
- Success metric: `TORGHUT_SIM` latest metrics count is non-zero for the required window and schema parity tests pass.
- Guardrail: no live notional; paper canary remains held while sim proof is empty.

Hypothesis 4:

- If market-context repair is targeted to candidates with fresh empirical and quant proof, context refresh spend will
  improve expected information value rather than burning budget on hypotheses that still lack core proof.
- Success metric: each market-context renewal names candidate, symbol set, provider config, and closure receipt.
- Guardrail: no heavy scan may run without a candidate-bound query budget.

## Implementation Scope

Engineer stage:

1. Add a renewal-batch model and serializer in Torghut.
2. Add scheduler support for proposing batches from stale empirical jobs, quant lag, sim emptiness, market-context
   health, GitOps drift, and alert severity.
3. Add submission-council checks that require a valid renewal batch and Jangar quiescence receipt before paper/live
   preparation.
4. Add `/trading/health` and `/trading/autonomy` fields summarizing active renewal batches.
5. Add tests for stale empirical jobs, quant not configured, sim empty, market context down, and Jangar quiescence hold.
6. Keep all repair batches zero-notional until Jangar emits `paper_canary=allow`.

Deployer stage:

1. Deploy renewal batches in observe-only mode.
2. Confirm batches are visible in Torghut and Jangar status surfaces.
3. Confirm repair jobs do not submit paper or live orders.
4. Enable paper-canary enforcement only after Jangar watch quiescence and batch closure receipts are present.
5. Do not enable live submission until GitOps drift is closed and the live capital gate names the renewal receipt.

## Validation Gates

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py`
- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pytest services/torghut/tests/test_trading_scheduler_safety.py`
- `uv run --frozen pytest services/torghut/tests/test_autonomy_evidence.py`
- `bunx oxfmt --check docs/torghut/design-system/v6/119-torghut-evidence-renewal-batches-and-capital-quiescence-gates-2026-05-06.md`
- Read-only production validation:
  - `curl http://torghut.torghut.svc.cluster.local/db-check`
  - `curl http://torghut.torghut.svc.cluster.local/trading/health`
  - `curl http://agents.agents.svc.cluster.local/api/torghut/trading/control-plane/quant/alerts?status=open`

Capital readmission requires:

- Current Torghut DB schema and account-scope projection.
- Jangar watch quiescence receipt for required control-plane streams.
- Fresh empirical replay receipt for the candidate.
- Live and sim quant receipts for the required account/window.
- Market-context receipt for the candidate symbol set.
- GitOps convergence receipt if the route or workflow is OutOfSync.
- Zero unresolved critical alerts for the candidate scope or explicit owner-approved carried debt.

## Rollout And Rollback

Rollout:

1. Add renewal-batch projection without enforcement.
2. Start emitting proposed batches from current stale proof.
3. Enforce renewal receipts for paper canary.
4. Enforce renewal receipts for live micro canary.
5. Enforce renewal receipts for live scale only after multiple session receipts.

Rollback:

- Disable renewal-batch enforcement and keep the projection visible.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and live notional at `0` during rollback.
- If a repair job causes load or query pressure, expire the batch and preserve its rejected receipt for audit.
- If Jangar watch quiescence regresses, capital gates return to `hold` while observe-only repairs can continue.

## Risks

- Expected profit value could be overtrusted. Mitigation: it ranks repair work only; it never proves realized PnL.
- Batch schemas can become too broad. Mitigation: lane-specific closure receipts and candidate-bound budgets.
- Market-context repair could spend heavily without useful alpha. Mitigation: require candidate, symbol set, and query
  budget before running.
- GitOps drift can make runtime health misleading. Mitigation: paper/live readmission requires convergence receipt when
  the touched route or workflow is OutOfSync.

## Handoff Contract

Engineer acceptance gates:

- A fixture matching the current evidence produces at least one renewal batch and keeps max notional at `0`.
- Submission council refuses paper/live preparation without a Jangar quiescence epoch id and batch closure receipt.
- Tests cover stale empirical jobs, quant not configured, live quant lag, empty sim metrics, market-context down, and
  open critical alerts.
- `/trading/health` exposes active renewal-batch state without replacing existing DB and live-submission checks.

Deployer acceptance gates:

- Observe-only rollout proves no repair batch submits paper or live orders.
- Paper canary remains held until Jangar watch quiescence and all required renewal receipts are present.
- Live micro canary remains held until GitOps drift is closed and live submission is explicitly enabled.
- Release handoff records the renewal batch ids, Jangar quiescence epoch ids, and rollback target before any capital
  stage change.
