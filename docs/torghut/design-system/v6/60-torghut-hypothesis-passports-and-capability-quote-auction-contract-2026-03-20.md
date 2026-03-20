# 60. Torghut Hypothesis Passports and Capability Quote Auction Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`

Extends:

- `59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`
- `58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`
- `57-torghut-profit-reserves-forecast-calibration-escrow-and-probe-auction-2026-03-20.md`
- `56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`

## Executive summary

The decision is to move Torghut from one coarse live-submission gate to per-lane **Hypothesis Passports** priced by a
durable **Capability Quote Auction**. Torghut should stop flattening mixed Jangar and local evidence into one
portfolio-wide `observe` answer and instead allocate only the capital class that the evidence can honestly support for
each hypothesis family.

The reason is visible in the live system on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - reports `live_submission_gate.allowed=false`
  - reports `capital_stage="shadow"` and `capital_state="observe"`
  - reports blocked reasons:
    - `alpha_readiness_not_promotion_eligible`
    - `empirical_jobs_not_ready`
    - `dependency_quorum_block`
    - `quant_health_fetch_failed`
    - `live_promotion_disabled`
  - still resolves `quant_evidence.source_url` from
    `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?...`
- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - returns `status="degraded"`
  - repeats the same quant-evidence fetch failure and shadow capital stage
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns `status="degraded"`
  - returns `latestMetricsCount=36`
  - returns `metricsPipelineLagSeconds=2`
  - returns `maxStageLagSeconds=95273`
- `kubectl get pods -n torghut -o wide`
  - shows the main Torghut revision `2/2 Running`
  - shows both `torghut-forecast` pods `0/1 Running`
  - shows both `torghut-forecast-sim` pods `0/1 Running`

The tradeoff is more persistence, more price-setting logic, and stricter guardrails around probe capital. I am keeping
that trade because the expensive failure mode is no longer raw safety. It is lost option value: the system blocks the
entire lane stack even when typed quant evidence and some non-forecast hypotheses still have usable information.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: improve Jangar resilience and Torghut profitability with merged architecture outputs

This artifact succeeds when:

1. every hypothesis lane binds to one durable passport that cites required Jangar admission passports and local
   evidence quotes;
2. wrong-endpoint authority becomes structurally impossible for quant-health and similar typed capabilities;
3. degraded forecast or market-context evidence can reduce only the affected capital class instead of forcing a global
   portfolio stop;
4. profitability hypotheses and guardrails are measurable enough to reject the design if it does not outperform the
   current global-block baseline in paper mode.

## Assessment snapshot

### Cluster and runtime evidence

Current Torghut runtime truth is mixed, not absent.

- the main trading service is running and answering requests;
- quant-health authority from Jangar is degraded but non-empty;
- forecast infrastructure is not ready;
- the live-submission gate still collapses those mixed facts into one shadow or observe answer.

Interpretation:

- Torghut already fails closed, which is safe;
- it does not yet preserve future option value when some capability classes remain usable;
- the wrong-endpoint fallback for quant evidence proves the current gate is still too path-centric and too coarse.

### Source architecture and high-risk modules

The code paths explain why the portfolio still over-blocks.

- `services/torghut/app/trading/submission_council.py`
  - `resolve_quant_health_url()` still derives authority from configured URL families;
  - `build_live_submission_gate_payload(...)` still settles one top-level gate for all lanes;
  - the current payload chooses one active capital stage rather than a lane-scoped passport set.
- `services/torghut/app/trading/hypotheses.py`
  - `JangarDependencyQuorumStatus` still reduces upstream truth to `decision`, `reasons`, and `message`;
  - runtime hypothesis summaries still compute coarse `capital_stage` buckets from shared dependency status.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - caches and reuses one live-submission gate;
  - the scheduler therefore remains coupled to the same coarse gate semantics exposed by status routes.
- `services/torghut/app/main.py`
  - `/readyz` and `/trading/status` both project the shared gate;
  - there is still no durable per-hypothesis passport id bridging runtime and status.

Current missing tests are architectural:

- no regression proves per-lane passport ids are shared by scheduler, `/readyz`, and `/trading/status`;
- no regression proves a degraded forecast cluster only clips forecast-dependent capital classes;
- no regression proves wrong-endpoint quant authority is rejected even when the fetched payload looks superficially
  valid;
- no regression proves the auction cannot allocate more than the configured bounded probe capital when evidence is
  mixed.

### Database, schema, and consistency evidence

Torghut persistence is ready for additive lane-scoped contracts.

- existing source already persists:
  - `strategy_hypotheses`
  - `strategy_hypothesis_metric_windows`
  - `strategy_capital_allocations`
  - `strategy_promotion_decisions`
- runtime health says the service can still read and project trading state;
- direct CNPG SQL remains intentionally constrained from this worker, so the design should rely on additive application
  persistence rather than wider database privileges.

Interpretation:

- the missing primitive is not another global gate bit;
- it is one durable passport and pricing layer between Jangar admission truth, local evidence quality, and capital
  allocation.

## Problem statement

Torghut still has five profitability-critical gaps:

1. it resolves critical upstream capability truth from URL families instead of one typed upstream passport;
2. it settles one coarse live-submission gate for many heterogeneous hypothesis families;
3. forecast or market-context degradation still destroys too much option value because the gate does not price
   capability quality per lane;
4. scheduler, `/readyz`, and `/trading/status` can remain aligned only by reusing the same coarse runtime function,
   not by citing one durable passport id;
5. there is no measurable mechanism for testing whether bounded degraded-mode allocation improves paper profitability
   without violating drawdown and freshness guardrails.

That is safe enough to avoid a blow-up. It is not a profitable six-month control system.

## Alternatives considered

### Option A: keep the global gate and only remove the wrong endpoint fallback

Summary:

- require the typed quant-health route;
- preserve the rest of the current live-submission gate structure.

Pros:

- smallest implementation delta;
- removes one concrete correctness bug quickly.

Cons:

- still over-blocks the whole portfolio on mixed evidence;
- still leaves scheduler and route parity dependent on one coarse gate function;
- does not create measurable degraded-mode profitability experiments.

Decision: rejected.

### Option B: move final capital truth into Jangar

Summary:

- Jangar would issue final lane capital eligibility and Torghut would mostly execute it.

Pros:

- simple top-level authority story;
- fewer Torghut-local policy objects.

Cons:

- couples infrastructure authority to trading-local economics;
- increases blast radius from Jangar mistakes;
- reduces future option value for Torghut experimentation and lane-specific alpha policies.

Decision: rejected.

### Option C: hypothesis passports plus capability quote auction

Summary:

- Jangar admission passports become one upstream input, not the entire answer;
- Torghut settles per-hypothesis passports that price local and upstream capability quality;
- a quote auction allocates bounded probe or canary capital only to passports whose guardrails permit it.

Pros:

- makes lane-local degradation explicit;
- preserves strict global safety while unlocking bounded degraded-mode learning;
- gives scheduler and status surfaces one durable passport id to share;
- creates measurable, falsifiable profitability hypotheses.

Cons:

- adds persistence and pricing logic;
- requires careful rollout because overly optimistic quote math could leak capital;
- demands explicit experiment gates and rollback rules.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will settle lane-scoped hypothesis passports and price them through a capability quote auction. Capital can
move only through those passports, not directly from coarse gate payloads or path-derived upstream truth.

## Architecture

### 1. Hypothesis-passport ledger

Add additive Torghut persistence:

- `hypothesis_passports`
  - `hypothesis_passport_id`
  - `hypothesis_id`
  - `lane_id`
  - `account_label`
  - `jangar_admission_passport_id`
  - `required_capabilities_json`
  - `decision` (`block`, `observe`, `probe`, `canary`, `live`)
  - `reason_codes_json`
  - `evidence_digest`
  - `issued_at`
  - `fresh_until`
  - `rollback_required`
- `hypothesis_passport_capabilities`
  - `hypothesis_passport_id`
  - `capability_kind` (`quant_health`, `market_context`, `forecast_calibration`, `empirical_jobs`, `feature_coverage`,
    `execution_trust`)
  - `required`
  - `quote_id`
  - `decision`
  - `evidence_ref`

Rules:

- scheduler, `/readyz`, and `/trading/status` must all cite the same passport id for the same lane and account;
- no hypothesis may advance capital without a fresh upstream Jangar admission passport and fresh local evidence quotes;
- wrong-endpoint upstream evidence is invalid even if the returned payload happens to parse.

### 2. Capability quote book

Add additive Torghut persistence:

- `capability_quotes`
  - `quote_id`
  - `capability_kind`
  - `subject_ref`
  - `source_kind` (`jangar_passport`, `forecast_runtime`, `market_context`, `empirical_jobs`)
  - `quality_score`
  - `confidence_score`
  - `fresh_until`
  - `max_capital_class` (`block`, `observe`, `probe`, `canary`, `live`)
  - `reason_codes_json`
  - `evidence_digest`
  - `producer_revision`
- `capability_quote_events`
  - immutable history for `issued`, `expired`, `repriced`, `revoked`

Rules:

- quotes price capability quality, not direct trading alpha;
- a degraded but fresh quote may still support bounded `probe` capital;
- a stale or unknown quote may not support anything above `observe`.

### 3. Capability quote auction

The auction is intentionally narrow.

- Inputs:
  - fresh hypothesis passports;
  - bounded probe budget;
  - recent realized slippage, fill rate, and drawdown;
  - quote quality and confidence.
- Output:
  - per-lane `allocated_capital_class`;
  - optional `probe_budget_bps`;
  - `next_reprice_at`;
  - `kill_switch_reason` when the auction rejects all candidates.

Hard guardrails:

- total degraded-mode probe capital stays below a fixed percentage of paper or shadow risk budget;
- any stale or unknown upstream Jangar passport forces `observe`;
- any drawdown or slippage breach bypasses the auction and forces `observe` or `block`;
- options or forecast-dependent lanes may not borrow capability from unrelated lanes.

### 4. Measurable profitability hypotheses

This design should be rejected if these hypotheses do not hold in paper mode:

1. Passport precision hypothesis:
   - lanes whose required capabilities remain healthy should maintain or improve decision throughput relative to the
     current global-block baseline.
   - measure: `decision_count`, `eligible_lane_count`, and `suppressed_reason_mix`.
2. Bounded degraded-mode learning hypothesis:
   - allowing `probe` capital only for lanes with fresh degraded-but-usable quotes should improve evidence generation
     without materially worsening simulated or paper drawdown.
   - measure: `probe_capital_pnl_bps`, `max_probe_drawdown_bps`, `probe_fill_rate`, `quote_expiry_cancellations`.
3. Authority-parity hypothesis:
   - scheduler, `/readyz`, and `/trading/status` should agree on the active passport id and capital class for every
     lane.
   - measure: `passport_parity_rate`, target `>= 99.9%`.

### 5. Immediate implementation scope

Engineer stage should land the smallest credible slice:

1. reject wrong-endpoint quant authority when the source URL is not the typed quant-health surface;
2. persist capability quotes for:
   - `quant_health`
   - `forecast_calibration`
   - `empirical_jobs`
3. persist one hypothesis passport per lane and account;
4. teach scheduler, `/readyz`, and `/trading/status` to cite the same passport id;
5. add a bounded `probe` capital class in shadow mode only.

### 6. Failure-mode reduction and profit upside

This design removes three current profit leaks:

- generic control-plane status can no longer masquerade as quant authority;
- forecast degradation can deallocate only forecast-dependent lanes instead of the whole portfolio;
- mixed evidence can still produce bounded, measurable learning instead of guaranteed inactivity.

## Validation and rollout contract

### Engineer acceptance gates

The engineer stage is complete only when all of these are true:

1. the wrong-endpoint quant-health fallback is rejected by passport compilation;
2. scheduler, `/readyz`, and `/trading/status` expose the same `hypothesis_passport_id` for a test lane;
3. a degraded-but-fresh quant quote can support `probe` but not `canary` or `live`;
4. a stale or missing Jangar admission passport forces `observe` or `block`;
5. regression tests cover per-lane capital isolation and auction budget caps.

### Deployer acceptance gates

The deployer stage is complete only when all of these are true:

1. passport and quote compilation runs in shadow mode with parity telemetry before capital behavior changes;
2. bounded `probe` capital is enabled only for paper or explicitly shadow-scoped accounts first;
3. daily verification confirms no lane exceeded the degraded-mode probe budget and no stale passport was used for
   capital allocation;
4. quote or passport drift automatically reverts affected lanes to `observe`.

## Rollout plan

1. Land quote and passport tables plus shadow-mode compiler.
2. Reject wrong-endpoint authority immediately.
3. Emit passport ids in scheduler and status surfaces without changing capital behavior.
4. Enable bounded `probe` capital for paper mode only.
5. Promote to broader use only if the measurable hypotheses beat the current baseline and guardrails remain clean.

## Rollback plan

Rollback is required if any of these occur:

- a lane receives `probe` or higher capital with a stale upstream passport;
- quote-parity or passport-parity drops below the agreed floor;
- degraded-mode probe capital exceeds the configured cap;
- drawdown or slippage metrics worsen beyond the planned guardrail relative to the global-block baseline.

Rollback path:

- keep quote and passport observation tables;
- disable auction-driven capital and fall back to the current global gate;
- preserve all emitted quotes and passports so the failed rollout is diagnosable and replayable.

## Risks and open questions

- quote math must remain conservative or the system will learn the wrong lesson from degraded data;
- too many capability kinds would turn the auction into an opaque optimizer; the first slice should stay small;
- lane manifests must declare required capabilities explicitly or the passport layer will inherit today’s ambiguity in
  a new form;
- profitability must be judged on evidence generation and risk-adjusted outcomes, not only raw decision count.
