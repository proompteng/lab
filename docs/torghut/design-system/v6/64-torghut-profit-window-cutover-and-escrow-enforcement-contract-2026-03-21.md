# 64. Torghut Profit Window Cutover and Escrow Enforcement Contract (2026-03-21)

Status: Approved for implementation (`plan`)
Date: `2026-03-21`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`

Extends:

- `63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`
- `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
- `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`

## Executive summary

The decision is to cut Torghut over to lane-local profit windows and evidence escrows through a shadow-and-enforce
plan, not a portfolio-wide hard switch. The reason is that the live system still has enough truth to keep learning,
but not enough contract discipline to price that truth safely.

The evidence is explicit:

- `GET http://torghut.torghut.svc.cluster.local/trading/status` at `2026-03-21T00:31:44Z`
  - reports `running=true` and `mode="live"`;
  - reports `live_submission_gate.allowed=false` with blocked reasons
    `alpha_readiness_not_promotion_eligible`, `empirical_jobs_not_ready`, `dependency_quorum_block`,
    `quant_health_fetch_failed`, and `live_promotion_disabled`;
  - still projects `quant_evidence.source_url="http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?account=PA3SX7FYNUTF&window=15m"`
    even though manifests now declare the typed quant-health route.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=15m`
  at `2026-03-21T00:30:38Z`
  - returns `status="degraded"`;
  - reports `latestMetricsCount=0` and `emptyLatestStoreAlarm=true`;
  - proves the typed route exists, but also proves off-session and empty-store semantics still need a contract.
- `GET http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
  - returns `ready=false`;
  - shows all four empirical jobs stale since `2026-03-19T10:31:27Z`;
  - still marks them truthful and persisted, which means stale truth must be priced, not discarded.
- `GET http://torghut.torghut.svc.cluster.local/db-check` at `2026-03-21T00:30:38Z`
  - returns `ok=true`, `schema_current=true`;
  - confirms head `0025_widen_lean_shadow_parity_status`;
  - still surfaces lineage fork warnings that should remain part of trading authority.
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - reports `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_signals"} 829`;
  - reports `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_microbars"} 1944`.
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 80`
  - shows repeated forecast readiness failures with HTTP `503`;
  - shows the live Torghut revision continuing to serve.

The reason for the selected plan is that one shared route-time gate is still flattening different evidence debts into
the same portfolio-wide answer. The tradeoff is more lane-local accounting and one market-session shadow period before
hard enforcement. I am keeping that trade because the profitability opportunity is in bounded, falsifiable learning,
not in continuing to block every lane whenever one evidence class drifts.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: improve Jangar resilience and safer rollout behavior while defining Torghut architecture that grows
  profitability with measurable hypotheses and bounded guardrails

This document succeeds when:

1. every hypothesis lane and account can cite one `profit_window_id` and its funding `evidence_escrow_id`s;
2. status, scheduler, and submission council all reuse the same window ids instead of recomputing route-time truth;
3. typed quant-health parity is proven from manifests through live status payloads before generic status-route fallback
   is removed;
4. stale empirical, forecast, or market-context evidence can degrade only the lanes that depend on it;
5. bounded repair-probe capital is explicit, measured, and revocable rather than implied by a generic blocked answer.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

Torghut is not in total outage. It is in mixed-evidence mode with too much global reduction.

- `/trading/status`
  - proves the runtime is active and still compiling hypotheses;
  - also proves all lanes are effectively trapped in `shadow` or `blocked`.
- `/trading/empirical-jobs`
  - proves empirical artifacts exist, are truthful, and are persisted;
  - also proves they are stale enough to block promotion.
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 80`
  - shows forecast revisions failing readiness while the main Torghut revision keeps serving;
  - proves the runtime has partial rather than total evidence loss.

Interpretation:

- the right question is not "is Torghut up?";
- the right question is "which lanes still have funded windows and which do not?"

### Source architecture and high-risk modules

The current code still computes too much authority in request-time reducers.

- `services/torghut/app/trading/submission_council.py`
  - validates the typed quant-health URL, which is correct;
  - still collapses multiple missing evidence classes into one shared gate decision.
- `services/torghut/app/trading/hypotheses.py`
  - still treats Jangar dependency truth as a global dependency input rather than a named window funding source.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still has no durable `profit_window_id` to bind decisions, repairs, and capital usage together.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - always degrades on `emptyLatestStoreAlarm`;
  - only gates `missingUpdateAlarm` by market hours, which means off-session empty-store semantics still need a
    better contract.
- `services/jangar/src/server/torghut-quant-runtime.ts`
  - still materializes quant state through process-local `globalThis` and `setInterval(...)` loops;
  - that is acceptable for metrics materialization, but not as final trading authority.

### Database, schema, freshness, and consistency evidence

The data layer is healthy enough to support lane-local accounting.

- `/db-check`
  - proves schema parity and lineage signatures;
  - preserves warnings that should remain attached to funded windows.
- ClickHouse guardrail exporter
  - proves freshness queries have meaningful fallback cost;
  - that cost should become an escrow input, not hidden background noise.
- empirical jobs endpoint
  - proves stale-but-truthful evidence exists and is queryable.

## Problem statement

The discover-stage window and escrow design defined the right objects, but it did not yet define the cutover contract.
Without that plan-stage layer, the implementation still risks three expensive mistakes:

1. a portfolio-wide hard block can persist even when some lanes have enough funded evidence to remain in bounded
   repair-probe or shadow mode;
2. live status can still project the generic Jangar status route as quant authority even after manifests and code are
   supposed to prefer the typed quant-health route;
3. off-session quant freshness and repeated ClickHouse fallback debt can keep appearing only as symptoms instead of as
   explicit priced evidence.

## Alternatives considered

### Option A: hard-cut every lane to window and escrow enforcement at once

Pros:

- fastest path to the target model;
- simplest end state once stable.

Cons:

- too risky while live status still shows generic quant authority projection;
- likely to over-block on the first release because lane-level parity has not been proven;
- would hide whether failures come from config drift, off-session freshness semantics, or genuine missing evidence.

Decision: rejected.

### Option B: keep the shared gate and just tune thresholds

Pros:

- smallest implementation delta;
- low short-term rollout risk.

Cons:

- preserves the portfolio-wide common-mode failure path;
- keeps profitability experiments tied to one generic blocked answer;
- does not create measurable funding records for repair-probe capital.

Decision: rejected.

### Option C: lane-local shadow windows, typed-route parity, and phased enforcement

Pros:

- directly addresses the March 21 live contradictions;
- allows profitability to improve through bounded lane-local learning instead of all-or-nothing gating;
- makes config parity and funding parity explicit before enforcement.

Cons:

- more compiler and projection work;
- requires deliberate cutover order by lane.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will shadow compile profit windows and evidence escrows per lane and account, prove typed quant-route parity,
then enforce lane-by-lane funding semantics. The shared gate becomes a consumer of those objects rather than the final
authority compiler.

## Planned architecture

### 1. Session-aware shadow windows and escrow compiler

Implement the additive objects from doc 63 and make them session-aware:

- `profit_window_id`
- `window_session_class` (`market_open`, `market_close`, `off_session`, `replay`)
- `decision` (`funded`, `partially_funded`, `underfunded`, `expired`, `quarantined`)
- `capital_state` (`shadow`, `repair_probe`, `canary`, `live`, `quarantine`)
- `required_escrow_ids_json`
- `blocking_escrow_ids_json`
- `reason_codes_json`

Plan requirement:

- `emptyLatestStoreAlarm` may not collapse every off-session window into the same degraded answer;
- off-session windows must preserve evidence truth while still preventing unauthorized live capital.

### 2. Typed quant-route parity and config contract

The typed quant route is now a hard cutover prerequisite.

Required proofs:

- manifests set `TRADING_JANGAR_QUANT_HEALTH_URL` to
  `/api/torghut/trading/control-plane/quant/health`;
- live `/trading/status` and submission-council projections report the typed route in `quant_evidence.source_url`;
- once parity is proven, the generic Jangar status route is no longer accepted as quant authority input.

This matters because live status still projects the generic route today even though `argocd/applications/torghut/knative-service.yaml`
and `services/torghut/app/trading/submission_council.py` are already aligned on the typed path.

### 3. Lane cutover order and measurable hypotheses

Cutover order:

1. `H-CONT-01` continuation
2. `H-REV-01` event-reversion
3. `H-MICRO-01` microstructure-breakout

Why this order:

- continuation already depends on fewer unique evidence classes;
- event-reversion depends on market-context freshness and should cut over only after that escrow is stable;
- microstructure-breakout is already blocked on feature coverage and drift checks, so it should be the last lane to
  consume the new contract.

Guardrails by lane:

- `H-CONT-01`
  - may enter `repair_probe` only when quant, empirical, and signal-continuity escrows are funded;
  - must still honor `min_post_cost_expectancy_bps >= 6` and `max_avg_abs_slippage_bps <= 12`.
- `H-REV-01`
  - requires market-context freshness escrow plus quant escrow before moving beyond `shadow`;
  - must still honor `min_post_cost_expectancy_bps >= 8` and `max_avg_abs_slippage_bps <= 12`.
- `H-MICRO-01`
  - may not enter `repair_probe` while `feature_rows_missing` or `drift_checks_missing` remains true;
  - must still honor `min_post_cost_expectancy_bps >= 10` and `max_avg_abs_slippage_bps <= 8`.

### 4. Shared projections for status, scheduler, and submission council

Required consumers:

- `services/torghut/app/trading/submission_council.py`
- `services/torghut/app/trading/hypotheses.py`
- `services/torghut/app/trading/scheduler/pipeline.py`
- `/trading/status`
- `/readyz`

Required parity:

- the same lane/account pair must emit the same `profit_window_id`, `decision`, and funding reasons everywhere;
- the shared gate may summarize, but it may not recompute authority differently from the compiler.

### 5. Escrow types and priced evidence debt

Every active lane window must be funded or blocked by named escrows:

- `jangar_quant`
- `empirical_jobs`
- `forecast`
- `market_context`
- `schema_lineage`
- `clickhouse_freshness`

Plan requirement:

- stale empirical jobs remain visible as truthful-but-expired escrows;
- ClickHouse fallback counters become degradations attached to `clickhouse_freshness` escrow rather than invisible
  background cost;
- forecast `503` may degrade only windows that require forecast escrow.

## Validation plan

Implementation is not complete until:

1. manifest contract tests prove live and sim deployments still set the typed quant-health URL;
2. regression tests prove submission council rejects generic status-route quant authority once cutover is enabled;
3. regression tests prove off-session windows do not masquerade as funded live windows just because they avoid
   `missingUpdateAlarm`;
4. regression tests prove stale empirical jobs create `expired` escrows, not a generic portfolio-wide blocker;
5. status, scheduler, and submission council project the same window ids for the same lane/account snapshot.

## Rollout plan

1. shadow write windows and escrows for one full market session.
2. enforce typed quant-route parity in status payloads before live-capital semantics change.
3. cut `H-CONT-01` over to window-backed `shadow` and bounded `repair_probe`.
4. cut `H-REV-01` over once market-context escrow is stable.
5. cut `H-MICRO-01` over only after feature-coverage and drift-governance escrows are populated.
6. retire generic route-time gate authority once all active lanes project funded or blocked windows consistently.

## Rollback plan

If the cutover misbehaves:

- revert shared gate enforcement to advisory mode;
- keep writing windows and escrows for forensic continuity;
- preserve expired and quarantined escrows instead of deleting them;
- restore portfolio-wide blocking only as a temporary safety valve, not as the new source of truth.

## Risks and follow-up

- overly generous repair-probe budgets could disguise underfunded windows as productive learning;
- overly strict off-session semantics could make the system useless outside market hours;
- typed-route parity must be proven in live status payloads, not just in code and manifests, or the cutover will be
  operating on a false assumption.

## Engineer handoff contract

Engineer stage is complete only when:

1. window and escrow persistence from doc 63 is landed with session-aware projection fields;
2. submission council, scheduler, and status all consume shared window ids rather than recomputing route-time truth;
3. manifest and runtime tests prove typed quant-route parity;
4. lane-level tests cover continuation, event-reversion, and microstructure guardrails separately.

## Deployer handoff contract

Deployer stage is complete only when live validation shows:

1. `/trading/status` reports the typed quant-health `source_url`, not the generic Jangar status route;
2. live and sim Torghut revisions keep window and escrow ids stable for the same lane/account snapshot;
3. stale empirical jobs appear as expired escrows and only block the lanes that require them;
4. no lane receives `repair_probe`, `canary`, or `live` capital without a funded or policy-allowed partially funded
   window.
