# 149. Torghut Profit Evidence Convergence Epochs And Quant Stage Arbitrage (2026-05-07)

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

I am selecting **Torghut profit evidence convergence epochs with quant-stage arbitrage** as the next profitability
architecture step.

The current system is close enough to observe, but not close enough to paper. At `2026-05-07T12:12Z`, Torghut was
serving revision `torghut-00256`, `/healthz` returned `ok`, `/db-check` returned schema-current, Alpaca was active,
Postgres and ClickHouse dependency checks were `ok`, and empirical jobs were fresh for the current chip candidate.
That is useful progress.

The same status snapshot still held all capital at zero notional. TCA was last computed on
`2026-04-02T20:59:45.136640Z`, average absolute slippage was about `568.61` bps against an `8` bps guardrail, market
context had no fresh timestamp, signal continuity had an active `cursor_ahead_of_stream` alert, forecast authority was
blocked by `registry_empty`, and all three hypotheses were shadow with `0` promotion eligible. Direct Jangar quant
health added the sharpest contradiction: latest metrics were fresh, but the ingestion stage lagged `66,462` seconds.

Torghut should stop treating these as separate repair facts. It should produce one `profit_evidence_convergence_epoch`
that prices the distance from zero-notional repair to paper and live capital. Each epoch must state which evidence
surfaces agree, which surfaces contradict, which hypothesis could profit after costs if repaired, and which repair has
the highest expected capital unlock per unit of runtime risk.

The tradeoff is that the first profitable paper order waits for convergence. I accept that. A quant system that cannot
explain whether its latest metrics, ingestion stage, TCA, market context, forecast registry, and hypothesis state are
from the same reality is not ready to spend capital.

## Runtime Objective And Success Metrics

Success means:

- Torghut emits a stable convergence epoch from `/trading/status` and `/trading/health`.
- The epoch joins proof floor, live submission gate, quant latest-store health, quant stage health, TCA, market
  context, signal continuity, forecast authority, empirical jobs, and hypothesis readiness.
- Each stale or contradictory proof surface becomes a priced repair candidate with expected after-cost dividend,
  expected capital unlock, zero-notional runtime budget, validation command, and TTL.
- The epoch distinguishes latest-metric freshness from stage freshness.
- The epoch makes `quant_stage_ingestion_lagged` and `quant_stage_materialization_lagged` first-class blockers for
  paper unless explicitly waived by a current companion Jangar epoch.
- Paper opens only when the proof floor is not `repair_only`, no capital contradiction exists, at least one hypothesis
  is promotion eligible, TCA is current, market context is current when required, and signal continuity has no active
  alert.
- Live micro opens only after a clean paper settlement epoch.
- Live scale opens only after expected shortfall coverage and rollback readiness are proven.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster Evidence

- `kubectl get pods -n torghut` showed `torghut-00256-deployment-7c4f6b57cf-ggzfs` `2/2 Running` and
  `torghut-sim-00356-deployment-777d8695dc-9bdl2` `2/2 Running`.
- Torghut Postgres `torghut-db-1`, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options
  enricher, websockets, exporters, Alloy, and Symphony were running.
- Recent Torghut events showed successful completion of `torghut-db-migrations`,
  `torghut-empirical-jobs-backfill`, `torghut-whitepaper-semantic-backfill`, and `torghut-whitepapers-bootstrap`.
- Recent Torghut events also showed startup and readiness timeouts during revision rollout.
- `kubectl get ksvc -n torghut`, CNPG CRDs, PDBs, and FlinkDeployment CRDs were forbidden to this service account.

### Trading Evidence

- `/healthz` returned HTTP 200.
- `/db-check` returned HTTP 200 with current Alembic head `0029_whitepaper_embedding_dimension_4096`.
- `/trading/health` returned HTTP 503 and `status=degraded`.
- `/trading/status` returned HTTP 200 with `mode=live`, `pipeline_mode=simple`, `running=true`,
  `submit_enabled=false`, and active revision `torghut-00256`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, `capital_stage=shadow`.
- Proof floor was `floor_state=repair_only`, `route_state=repair_only`, `capital_state=zero_notional`,
  `max_notional=0`.
- Proof blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`, and
  `simple_submit_disabled`.
- TCA had `13,775` orders, average absolute slippage `568.6138848199565249` bps, and a strictest promotion guardrail
  of `8` bps.
- TCA age was `2,992,365` seconds against a proof-floor threshold of `86,400` seconds.
- Signal continuity had `signal_lag_seconds=196`, `signal_continuity_alert_active=true`,
  `signal_continuity_alert_reason=cursor_ahead_of_stream`, and `signal_continuity_recovery_streak=1`.
- Feature quality rejected `65` cursor commits for `feature_staleness_exceeds_budget`.
- Market context had no current freshness timestamp.
- Forecast service was `degraded`, `authority=blocked`, `message=registry_empty`.
- Empirical jobs were healthy and truthful on dataset `torghut-chip-full-day-20260505-5e447b6d-r1` and candidate
  `chip-paper-microbar-composite@execution-proof`.
- Alpha readiness had `3` hypotheses, all `shadow`, `0` promotion eligible, and `3` rollback required.
- Direct Jangar quant health for account `PA3SX7FYNUTF` and window `15m` showed latest metrics current, compute stage
  healthy, materialization stage unhealthy, and ingestion stage lag `66,462` seconds.

### Database And Data Evidence

- Runtime Postgres and ClickHouse dependency checks were `ok`.
- `/db-check` reported schema current, lineage ready, branch count `1`, and duplicate-revision set empty.
- `/db-check` also reported historic parent-fork warnings:
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Direct CNPG psql was blocked because the service account cannot create `pods/exec` in namespace `torghut`.
- Direct ClickHouse query credentials were not available from this runner, and earlier unauthenticated checks returned
  `REQUIRED_PASSWORD`.
- Data quality is therefore assessed through typed runtime surfaces and source schema. That is the right default for
  engineer/deployer validation, because capital admission should not require privileged shell access.

### Source Evidence

- `services/torghut/app/main.py` is `4,145` lines and assembles `/trading/status`, `/trading/health`, proof floor,
  live submission gate, empirical jobs, quant evidence, forecast status, and hypothesis readiness. New convergence
  logic should not be embedded directly in this file.
- `services/torghut/app/trading/proof_floor.py` already emits proof dimensions and a repair ladder, but it does not
  join all dimensions into a same-epoch capital object.
- `services/torghut/app/trading/submission_council.py` blocks live submission on promotion, empirical, DSPy,
  dependency quorum, and required quant evidence, but quant is currently non-blocking when configured as
  informational.
- `services/torghut/app/trading/empirical_jobs.py` correctly enforces empirical job freshness, truthfulness, dataset
  consistency, candidate consistency, and promotion authority.
- `services/torghut/migrations/versions/0009_execution_tca_metrics.py` owns execution TCA storage and aggregate
  views.
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py` owns persistent hypothesis governance
  tables.
- `services/torghut/migrations/versions/0028_autoresearch_epoch_ledgers.py` owns autoresearch epoch ledgers.
- The missing source boundary is a convergence reducer that prices proof contradictions without widening capital.

## Problem

Torghut has several good proof surfaces, but they are not in the same time domain. Fresh empirical proof can coexist
with stale TCA, stale market context, lagged quant ingestion, and zero promotion-eligible hypotheses. That makes the
system safe because capital is held, but slow because the repair priority is still implicit.

The failure modes are:

1. The proof floor says which dimensions failed, but not which repair has the highest after-cost capital dividend.
2. Quant latest metrics can be fresh while ingestion-stage evidence is stale.
3. Schema current can be true while capital-grade data freshness is false.
4. Market-closed expected staleness can mask an active signal-continuity alert.
5. Empirical jobs can look strong while every hypothesis remains blocked for capital.

## Alternatives Considered

### Option A: Promote Paper From Fresh Empirical Jobs

Pros:

- Fastest path to new observations.
- Uses the strongest positive evidence currently available.
- Requires little new code.

Cons:

- Ignores stale TCA and extreme slippage.
- Ignores lagged quant ingestion and stale market context.
- Produces paper evidence that cannot honestly support live capital.

Decision: reject.

### Option B: Continue With The Current Proof-Floor Repair Ladder

Pros:

- Already implemented and visible.
- Keeps capital safe.
- Gives a simple ranked list of repairs.

Cons:

- Does not reconcile evidence clocks.
- Does not price expected after-cost dividend.
- Does not distinguish latest-store freshness from stage freshness.
- Leaves Jangar to infer contradictions from generic consumer evidence.

Decision: reject.

### Option C: Add Profit Evidence Convergence Epochs

Pros:

- Creates one account/revision/window object for capital evidence.
- Makes proof contradictions explicit and measurable.
- Allows repair scheduling to target the largest expected capital unlock first.
- Keeps paper/live closed until evidence clocks agree.
- Gives Jangar a typed companion object for its observation epoch tripwire.

Cons:

- Adds another reducer and schema.
- Requires calibration of expected dividend estimates.
- Can keep paper closed longer during data-plane recovery.

Decision: select Option C.

## Architecture

Torghut adds a convergence reducer outside `app/main.py`.

```text
profit_evidence_convergence_epoch
  epoch_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  proof_floor_ref
  live_submission_gate_ref
  evidence_receipts[]
  contradiction_codes[]
  repair_candidates[]
  capital_floor
  paper_gate_state
  live_gate_state
```

Evidence receipts are normalized before scoring:

- `schema_receipt`: db-check head, graph signature, lineage warnings, account-scope status.
- `quant_latest_receipt`: latest metrics count, latest update timestamp, latest-store lag.
- `quant_stage_receipt`: per-stage ok flag, per-stage lag, stage as-of time.
- `tca_receipt`: order count, last computed timestamp, average absolute slippage, guardrail.
- `market_context_receipt`: freshness, quality, domain states, failure mode.
- `signal_receipt`: signal lag, alert state, alert reason, recovery streak.
- `empirical_receipt`: candidate id, dataset snapshot ref, eligible jobs, stale jobs, truthful flag.
- `hypothesis_receipt`: promotion eligible count, rollback required count, blockers by hypothesis.
- `forecast_receipt`: registry ref, authority, calibration status, eligible model families.

Repair candidates are scored by:

```text
priority_score =
  expected_after_cost_dividend_bps
  * expected_capital_unlock_ratio
  * confidence
  / max(1, runtime_budget_minutes)
```

The initial implementation may use deterministic weights from existing proof-floor priority and empirical job
maturity. It should not try to learn this score until settlement history exists.

## Validation Gates

Engineer gates:

- Unit tests for `profit_evidence_convergence_epoch` with the `2026-05-07T12:12Z` evidence shape.
- Fixture where TCA is stale and blocks paper despite fresh empirical jobs.
- Fixture where quant latest metrics are fresh but ingestion stage lag creates `quant_stage_ingestion_lagged`.
- Fixture where schema is current but capital data is stale creates `db_schema_current_but_capital_data_stale`.
- Fixture where all receipts are current allows paper while live remains held until paper settlement exists.
- `cd services/torghut && uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_submission_council.py`.
- `bunx oxfmt --check docs/torghut/design-system/v6`.

Deployer gates:

- `GET /healthz` returns HTTP 200.
- `GET /db-check` returns HTTP 200 and expected head `0029_whitepaper_embedding_dimension_4096`.
- `GET /trading/health` may remain HTTP 503 while capital is correctly held; the payload must include the convergence
  epoch once implemented.
- `GET /trading/status` shows `capital_state=zero_notional` while contradictions exist.
- Direct Jangar quant health and Torghut quant receipt agree on stage freshness before paper opens.
- Paper remains disabled while `simple_submit_disabled`, `tca_evidence_stale`, `market_context_stale`,
  `quant_stage_ingestion_lagged`, or `hypothesis_promotion_absent` is present.

## Rollout

1. Add the reducer and fixtures in shadow mode.
2. Include the epoch in `/trading/status` and `/trading/health` behind a feature flag.
3. Publish the epoch ref into the proof floor and live submission gate payloads.
4. Let Jangar consume the epoch as non-authoritative evidence for at least three hourly schedule windows.
5. Make the epoch authoritative for paper only.
6. After clean paper settlement, use the same epoch chain for live micro.

## Rollback

Rollback must always return to zero notional:

- Disable the convergence epoch feature flag.
- Remove epoch-derived paper/live allowances.
- Keep `simple_submit_enabled=false`.
- Keep `capital_state=zero_notional`.
- Continue serving the existing proof floor and repair ladder.
- Re-enable the epoch only after the stale receipt or contradictory stage is repaired.

## Risks

- Scoring repair candidates can look more scientific than it is. Mitigation: label first-release scores as
  deterministic priority estimates and require observed settlement history before using learned weights.
- Quant stage health may be noisy near market close. Mitigation: use market-window-aware thresholds and require
  repeated clean epochs before paper opens.
- The reducer can grow into a second `main.py`. Mitigation: put it in a dedicated module with typed fixtures and keep
  route handlers thin.
- Direct privileged database validation is blocked for this runner. Mitigation: rely on `/db-check`, typed route
  receipts, and Jangar observation epochs for ordinary deployer gates.

## Handoff

Engineer:

- Own a new reducer under `services/torghut/app/trading/` and focused tests.
- Keep route integration additive.
- Do not enable paper from empirical jobs alone.
- Include quant stage health as a separate receipt from quant latest-store freshness.
- Emit stable contradiction codes for Jangar.

Deployer:

- Validate schema current, Torghut status, Torghut health, Jangar quant stage health, and Jangar observation epoch in
  the same rollout window.
- Keep paper/live blocked until the epoch has no capital contradictions.
- Roll back by disabling the epoch and preserving zero-notional capital.
