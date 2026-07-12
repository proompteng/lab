# 162. Torghut Profit Evidence Refill And Capital Route Reentry (2026-05-07)

Status: Accepted for engineer and deployer handoff

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

I am selecting profit-evidence refill with capital route reentry as the next Torghut architecture step.

Torghut is available but not capital-ready. Live `/readyz` returns HTTP 503. The autonomy service is disabled, the
forecast registry is empty, empirical jobs are stale, Jangar quant health for `paper/1d` has zero latest metrics, and
alpha readiness has three hypotheses with zero promotion-eligible hypotheses. The system also has useful raw facts:
signal lag is low, feature quality is clean, TCA has 7334 orders, and the runtime is already failing closed on capital.

The right move is not to relax guardrails. The right move is to build an evidence refill lane that repairs the missing
profit proof surfaces without earning capital authority. A `profit_evidence_refill` object should capture which
evidence class is stale or empty, which Jangar controller ingestion epoch authorized bounded repair, which Torghut
revision produced the refill, which before/after proof changed, and whether the refill is good enough to re-enter a
paper route cohort. Capital reentry remains separate and stricter.

The tradeoff is patience. Some repairs will refill metrics and still leave capital closed. That is acceptable because
we need fewer false promotions, not faster weak promotions.

## Runtime Objective And Success Metrics

Success means:

- `/trading/autonomy`, `/readyz`, and `/trading/status` expose `profit_evidence_refill` and `capital_route_reentry`.
- A refill cites the active Jangar `controller_ingestion_epoch_id` and is rejected if Jangar only allows read-only
  observation.
- Empirical jobs, quant latest projection, market context, routeability snapshots, and TCA projections each have a
  named refill class with before/after evidence.
- Jangar quant health for `paper/1d` no longer remains empty when Torghut has fresh qualifying proof to publish.
- Route reentry requires at least two routeable symbols for paper canary and a complete proof tuple for live micro
  canary.
- Live capital remains zero-notional until proof floor is closed, routeability is current, market context is fresh,
  alpha readiness is promotion eligible, quant stages are fresh, and Jangar epoch status is valid.
- Deployer output can explain every capital block with one route reentry decision and one refill board entry.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records, ClickHouse
tables, GitOps resources, AgentRun objects, broker state, or trading flags.

### Runtime Evidence

- `GET http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503.
- `GET /trading/autonomy` returned `enabled=false`.
- `forecast_service.status=degraded`, `forecast_service.message=registry_empty`, and no eligible forecast models were
  present.
- `lean_authority.status=disabled` with deterministic scaffold only.
- Empirical jobs were `degraded` and stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- The stale empirical jobs all cited dataset snapshot `torghut-chip-full-day-20260505-5e447b6d-r1` and candidate
  `chip-paper-microbar-composite@execution-proof`.
- Simulation was disabled in the live autonomy endpoint.

### Jangar Projection Evidence

- Jangar quant health for `account=paper&window=1d` returned `status=degraded`.
- `latestMetricsUpdatedAt=null`, `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and `stages=[]`.
- Runtime metrics collection was enabled in Jangar with `runtimeStarted=true`, `runtimeEnabled=true`, and
  `runtimeAlertsEnabled=true`.
- Jangar control-plane status reported Torghut empirical services degraded for forecast and jobs.
- Jangar source rollout truth held paper and live capital because source/GitOps truth and controller ingestion witness
  were not current.

### Torghut Metrics Evidence

- Torghut Prometheus metrics showed `torghut_trading_signal_lag_seconds=23`.
- Feature quality was clean: `feature_null_rate` for `macd`, `macd_signal`, `price`, and `rsi14` was zero.
- `torghut_trading_feature_staleness_ms_p95` was 3881.
- TCA had `torghut_trading_tca_order_count=7334`.
- Average absolute slippage was about `13.82` bps, above the 8 bps guardrail used by recent proof-floor contracts.
- `torghut_trading_hypothesis_state_total{state="shadow"}=3`.
- `torghut_trading_alpha_readiness_hypotheses_total=3`.
- `torghut_trading_alpha_readiness_promotion_eligible_total=0`.
- `torghut_trading_alpha_readiness_rollback_required_total=3`.
- Route provenance gauges were zero, which means the route proof surface cannot justify live reentry.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` already emits proof-floor state and blockers.
- `services/torghut/app/trading/tca.py` owns execution cost and routeability facts.
- `services/torghut/app/trading/revenue_repair.py` can score repair value but does not yet settle refill authority.
- `services/torghut/app/trading/submission_council.py` remains the deterministic submission gate and should remain the
  final live order blocker.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` stores `quant_metrics_latest`,
  `quant_metrics_series`, `quant_alerts`, and `quant_pipeline_health`, but the live `paper/1d` projection is empty.
- Tests exist for quant health, submission council blocking, TCA, signal ingest, and policy checks. The missing test
  surface is refill eligibility across Jangar epoch status, empirical staleness, quant latest emptiness, routeability,
  TCA guardrails, and paper/live reentry.

## Problem

Torghut has a healthy fail-closed posture and a weak repair economy. The system knows why capital is closed, but it
does not publish a bounded, measurable path to refill proof without accidentally granting capital.

The observed gap is concrete:

1. Empirical jobs are stale even though the last known artifacts were truthful and promotion-authority eligible when
   created.
2. Jangar quant projection is empty for `paper/1d`, so Jangar sees no latest profit metrics for the account/window
   that capital gates care about.
3. Runtime TCA and feature metrics exist, but they are not settled into a refill receipt that can update the projection
   safely.
4. Alpha readiness and route provenance remain closed, so fresh metrics alone must not imply paper or live capital.

## Alternatives Considered

### Option A: Re-run Empirical Jobs Manually

Pros:

- Simple operationally.
- Keeps capital closed.
- Produces updated job artifacts if the runner path is healthy.

Cons:

- Does not bind the repair to Jangar controller authority.
- Does not refill the Jangar quant projection.
- Does not rank which stale evidence class has the highest unblock value.

Decision: reject as incomplete.

### Option B: Let Jangar Quant Runtime Recompute From Whatever Is Available

Pros:

- Fast path to fill `quant_metrics_latest`.
- Uses existing Jangar storage and API.
- Could clear the empty latest store alarm quickly.

Cons:

- It can hide that empirical jobs, routeability, and alpha readiness are still stale or blocked.
- It does not establish Torghut revision ownership of the refill.
- It risks treating a projection write as capital proof.

Decision: reject as too permissive.

### Option C: Add Profit-Evidence Refill And Capital Route Reentry

Pros:

- Refills stale or empty evidence in bounded classes.
- Requires Jangar controller ingestion authority before repair work.
- Separates evidence refill from paper and live capital reentry.
- Produces before/after proof so repair value is measurable.

Cons:

- Adds a reducer and persistence model.
- Requires Torghut and Jangar to share a small refill contract.
- Keeps capital closed until multiple proof surfaces converge.

Decision: select Option C.

## Architecture

Add a `profit_evidence_refill` reducer under `services/torghut/app/trading/`. It should be pure and should be callable
from HTTP status assembly and tests without requiring live database writes.

`ProfitEvidenceRefill` fields:

- `refill_id`
- `refill_class`
- `account_label`
- `window`
- `service_revision`
- `image_digest`
- `jangar_controller_ingestion_epoch_id`
- `jangar_refill_gate_decision`
- `before_ref`
- `after_ref`
- `before_state`
- `after_state`
- `expected_unblock_value`
- `observed_unblock_delta`
- `capital_authority`: always `none` for refill receipts
- `decision`: `allowed`, `held`, or `blocked`
- `reason_codes`
- `issued_at`
- `fresh_until`

Add `capital_route_reentry` as a stricter reducer that consumes refill receipts, proof floor, TCA, alpha readiness,
market context, routeability, quant health, submission policy, and Jangar epoch status.

Paper canary requires:

- Jangar active controller ingestion epoch `valid`.
- Source/GitOps truth present in Jangar.
- Proof floor not `repair_only`.
- At least two routeable scoped symbols.
- Market context fresh for every routeable symbol.
- Alpha readiness promotion eligible for the candidate.
- Quant latest count greater than zero for the account/window.
- Quant pipeline max lag below 300 seconds.
- Average absolute slippage at or below the active guardrail.
- Submission policy allows paper.

Live micro canary additionally requires:

- Route provenance coverage at or above 95 percent for the proof window.
- Zero unresolved critical quant alerts.
- No rollback-required alpha readiness entries.
- Simple submit or the deterministic execution adapter enabled.
- Explicit live approval token path unchanged from current governance policy.

## Measurable Trading Hypotheses

The refill lane should track hypotheses as repairable proof claims, not capital permission.

- H1: refreshing empirical jobs on the stale 2026-05-05 chip dataset within a current Jangar epoch reduces the stale
  job blocker count from four to zero without increasing policy violations.
- H2: publishing qualifying Torghut proof into Jangar `quant_metrics_latest` changes `paper/1d` from empty to nonempty
  within two compute intervals while keeping `capital_authority=none`.
- H3: routeability repair increases live or paper scoped routeable symbols from zero or one to at least two while
  keeping average absolute slippage within the configured guardrail.
- H4: market-context refill clears stale context for routeable symbols without admitting symbols that lack TCA or
  alpha readiness.
- H5: capital route reentry remains blocked when any one of Jangar epoch, proof floor, routeability, market context,
  alpha readiness, quant freshness, TCA, or submission policy is missing.

## Implementation Scope

Torghut engineer owns:

- Add pure dataclasses or typed dictionaries for `ProfitEvidenceRefill` and `CapitalRouteReentry`.
- Add reducer functions under `services/torghut/app/trading/`.
- Wire reducer output into `/trading/autonomy`, `/readyz`, and `/trading/status`.
- Add optional persistence only after the pure reducer is green in tests.
- Add tests for stale empirical job refill, empty Jangar quant projection, routeability before/after, TCA guardrail
  breach, alpha readiness block, Jangar epoch missing, paper canary hold, and live micro canary block.

Jangar engineer owns:

- Expose the active controller ingestion epoch and refill gate.
- Keep quant projection writes separate from capital authority.
- Reject refill requests that lack an active epoch or request a class outside the bounded repair list.

## Validation Gates

Minimum local validation:

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k 'control_plane_contract or alpha_readiness'`
- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py`
- `bun run --cwd services/jangar test -- src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`
- `bunx oxfmt --check docs/torghut/design-system/v6/162-torghut-profit-evidence-refill-and-capital-route-reentry-2026-05-07.md`

Runtime acceptance:

- `profit_evidence_refill` appears in `/trading/autonomy` with `capital_authority=none`.
- Empty Jangar quant projection can be refilled only when Jangar refill gate allows the class.
- Paper canary remains held while routeable symbol count is below two, market context is stale, alpha readiness is not
  promotion eligible, or Jangar epoch is not valid.
- Live micro canary remains blocked while route provenance coverage is zero or simple submit remains disabled.
- Refill receipts include before/after refs and do not overwrite stale blockers without proof.

## Rollout Plan

1. Ship reducer output in shadow mode with no persistence.
2. Compare reducer decisions against current proof-floor and submission-council blockers for one trading session.
3. Enable Jangar refill gate consumption for `quant_latest_projection_refill` only.
4. Add empirical job and market-context refill classes after quant projection proves non-capital behavior.
5. Enable paper route reentry only after at least two routeable symbols meet all paper gates.
6. Keep live route reentry blocked until route provenance, submission policy, alpha readiness, and Jangar epoch are all
   current.

## Rollback

Rollback is fail-closed:

- Remove `profit_evidence_refill` from capital route reentry decisions while leaving it in status for audit.
- Disable Jangar refill gate consumption and return to manual repair approval.
- Clear any scheduled refill work by disabling the refill class flag, not by deleting receipts.
- Keep proof floor and submission council as the final paper/live gates.
- Keep live capital zero-notional until the previous stable proof-floor path is current.

## Risks And Tradeoffs

- Refill could be mistaken for capital permission. Mitigation: every refill receipt carries `capital_authority=none`.
- Jangar quant projection could fill with low-quality data. Mitigation: require before/after refs, freshness windows,
  and no capital effect from projection writes alone.
- Routeability repair could overfit one symbol. Mitigation: paper reentry requires at least two routeable symbols and
  fresh market context.
- Empirical jobs could stay stale if runners fail. Mitigation: classify as `held` with explicit runner blocker instead
  of widening capital.
- Strict gates slow paper learning. I accept that because current live state has zero routeable symbols and no
  promotion-eligible hypotheses.

## Handoff To Engineer And Deployer

Engineer acceptance:

- Implement pure reducers and tests before persistence.
- Publish refill and route reentry output in status endpoints.
- Bind every refill to a Jangar controller ingestion epoch.
- Keep refill receipts non-capital by schema and tests.

Deployer acceptance:

- Allow refill work only for classes admitted by Jangar.
- Keep paper canary held until the route reentry reducer says `paper_canary=allow`.
- Keep live micro canary blocked until all live gates pass and explicit live governance remains satisfied.
- Roll back by disabling refill classes and leaving receipts visible.
