# 75. Torghut Cross-Plane Evidence Epochs and Profit Cell Governor (2026-05-05)

Status: Approved for implementation (`discover`)

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


## Executive Summary

The decision is to make the next Torghut quant step a cross-plane evidence epoch and profit-cell governor, not another
local strategy sweep or another Jangar-only reliability patch.

The reason is evidence. Torghut has a live service that answers `/healthz`, but `/readyz` and `/trading/status` timed
out during this assessment. Jangar can report its own database healthy with `25/25` migrations applied, but its
Torghut quant-health route timed out and its control-plane status blocks empirical services. The Torghut sim rollout
has one running replica and one `ImagePullBackOff` replica on a promoted digest that lacks a matching platform. Direct
database and ClickHouse reads are blocked from this worker by RBAC or authentication, so promotion cannot depend on
privileged shell access.

The tradeoff is that we slow down non-observe capital promotion until the system can prove four things together:
runtime authority, data freshness, image portability, and post-cost profit evidence. I am keeping that trade because
it protects profitability. A fast strategy factory on stale tape or a non-portable image is a drawdown machine with
better vocabulary.

## Runtime Inputs and Success Metrics

Mission inputs observed for this architecture lane:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarm: `torghut-quant`
- stage: `discover`
- owner channel: `swarm://owner/trading`
- live channel: `general`

This design succeeds when:

1. Torghut scheduler, `/readyz`, `/trading/status`, promotion checks, and Jangar quant-control routes all cite the
   same active `evidence_epoch_id`.
2. Every non-observe hypothesis has one active `profit_cell_id` with source freshness, image portability, post-cost
   evidence, drawdown, capacity, and rollback receipts.
3. A stale or unreachable data authority blocks only the affected hypothesis or data segment, not the whole portfolio
   when unrelated observe/probe work can continue safely.
4. Promotion to canary/live is impossible without fresh Jangar admission, fresh market data warrants, portable image
   receipts, and settled post-cost profit tapes.
5. Engineer and deployer stages can validate the design without privileged database shell access.

## Assessment Evidence

All cluster and database work in this run was read-only.

### Cluster Health, Rollout, and Events

Observed commands and outcomes:

- `kubectl get pods -n torghut -o wide`
  - core Torghut pod `torghut-00202-deployment-677db4fc7f-5cqgl` is `2/2 Running`;
  - ClickHouse, Keeper, Torghut DB, WS, TA, and exporters are running;
  - `torghut-sim-00280-deployment-77d5694d7b-6zvfs` is `2/2 Running`;
  - `torghut-sim-00280-deployment-6f844b4647-np4x6` is `0/2 ImagePullBackOff`.
- `kubectl get pod -n torghut torghut-sim-00280-deployment-6f844b4647-np4x6 -o jsonpath=...`
  - node: `talos-192-168-1-194`;
  - reason: `ErrImagePull`;
  - message: `no match for platform in manifest sha256:d278a4d4267f011ba559dc51401acc6ac8f43d44a766b61f29a4d01859cce5cf`.
- `kubectl get events -n torghut --sort-by=.lastTimestamp`
  - shows Knative revision churn around `torghut-00200`, `torghut-00201`, and `torghut-00202`;
  - shows repeated readiness/startup probe failures during rollout;
  - shows `LatestReadyFailed` for older Torghut and sim configurations;
  - shows the current sim image pull failure continuing.
- `curl http://torghut-00202-private.torghut.svc.cluster.local:8012/healthz`
  - returns HTTP `200` with `{"status":"ok","service":"torghut"}`.
- `curl http://torghut-00202-private.torghut.svc.cluster.local:8012/readyz`
  - times out after six seconds with no body.
- `curl http://torghut-00202-private.torghut.svc.cluster.local:8012/trading/status`
  - times out after six seconds with no body.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health`
  - times out after eight seconds with no body.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status`
  - returns HTTP `200`;
  - reports `execution_trust.status="degraded"`;
  - reports `dependency_quorum.decision="block"`;
  - reports empirical forecast, lean, and jobs services as degraded because Torghut status is unavailable.

Interpretation:

- Liveness is not readiness.
- A partially portable image digest is now a trading-system failure mode because it can split sim truth by node.
- Jangar and Torghut are each telling the truth locally, but the hot path lacks one cross-plane authority receipt.

### Source Architecture and Test Surface

Source evidence:

- `find services/torghut/app/trading -name '*.py' | wc -l`
  - `123` trading Python modules.
- `find services/torghut/tests -name '*.py' | wc -l`
  - `146` Python test files.
- Largest trading modules by line count:
  - `services/torghut/app/trading/autonomy/lane.py`: `7377` lines;
  - `services/torghut/app/trading/autonomy/policy_checks.py`: `6072` lines;
  - `services/torghut/app/trading/research_sleeves.py`: `5254` lines;
  - `services/torghut/app/trading/scheduler/pipeline.py`: `4273` lines;
  - `services/torghut/app/trading/decisions.py`: `3293` lines.
- `services/torghut/scripts/check_migration_graph.py`
  - documents an intentionally branched migration graph with an allowlisted divergent signature.
- `uv` is not available in this worker, so the migration graph script could not be executed locally:
  - `/bin/bash: line 1: uv: command not found`.
- `services/jangar/src/server/torghut-quant-metrics-store.ts`
  - persists quant latest metrics, metric series, alerts, and pipeline health in `torghut_control_plane`;
  - already has the right query shape for a compact data freshness receipt.

Interpretation:

- Torghut has meaningful test volume, but the highest-risk modules are large enough that new authority behavior needs
  narrow contracts and focused tests.
- The design should avoid adding another monolithic gate inside `policy_checks.py` or `autonomy/lane.py`.
- The right shape is an additive receipt consumed by those modules, not more request-time inference in them.

### Database, Data Quality, Freshness, and Consistency

Database/data evidence:

- `kubectl get svc -n torghut`
  - shows `torghut-db-ro`, `torghut-db-rw`, and `torghut-clickhouse` services;
  - shows ClickHouse, Keeper, exporters, TA, WS, Knative revision services, and Torghut tailscale service.
- `kubectl get configmap -n torghut torghut-autonomy-config -o jsonpath='{.data}'`
  - shows `TRADING_STRATEGY_RUNTIME_MODE="scheduler_v3"`;
  - shows allocator, fragility, forecast-router, evidence-continuity, stale-signal, and runtime-circuit settings.
- `kubectl cnpg psql -n torghut torghut-db ...`
  - fails because `pods/exec` is forbidden for `system:serviceaccount:agents:agents-sa`.
- `kubectl exec -n torghut chi-torghut-clickhouse-default-0-0-0 -- clickhouse-client ...`
  - fails because `pods/exec` is forbidden.
- `curl http://torghut-clickhouse.torghut.svc.cluster.local:8123/?query=SELECT...`
  - returns HTTP `401` with ClickHouse `REQUIRED_PASSWORD`.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status`
  - reports Jangar database connected and migration consistency healthy;
  - reports `registered_count=25`, `applied_count=25`, and `unapplied_count=0`.

Interpretation:

- The worker cannot inspect Torghut rows directly without credentials or exec rights. That is a useful constraint, not
  a reason to weaken the design.
- Data readiness must be exposed through bounded, typed, read-only projections that constrained automation can read.
- Promotion cannot depend on "someone can shell into Postgres" as the validation model.

## Problem Statement

Torghut quant currently has too many ways to be locally truthful and globally unsafe:

1. `/healthz` can be green while `/readyz` and `/trading/status` time out.
2. Jangar can have a healthy database and still block execution trust and empirical services.
3. A promoted Torghut image digest can run on one node and fail on another node because of platform mismatch.
4. Quant health can time out from Jangar while Torghut promotion logic still needs an answer.
5. Direct database and ClickHouse inspection is unavailable to normal workers, but the current architecture still
   leans on DB-backed truth that is not always projected as bounded receipts.
6. Strategy research is powerful enough to generate candidates, but a stale tape, stale empirical job, or non-portable
   image can invalidate the result after the fact.

The architecture gap is a missing cross-plane authority chain. Torghut needs to prove that a hypothesis is profitable
and deployable in the same epoch, with the same data freshness, runtime, and image assumptions.

## Alternatives Considered

### Option A: Fix Rollout and Image Portability First, Then Resume Research

Summary:

- Treat the sim image mismatch and readiness timeouts as operational bugs.
- Repair those before changing the architecture.

Pros:

- addresses the current visible outage class;
- likely improves near-term operator confidence.

Cons:

- does not prevent the next non-portable or stale-data promotion;
- does not give strategy promotion one durable authority receipt;
- leaves Jangar/Torghut route-time drift intact.

Decision: rejected as the primary architecture direction. The fixes are required implementation work, but not enough.

### Option B: Accelerate Strategy Factory and MLX Autoresearch First

Summary:

- Put the bulk of engineering effort into more candidate generation, better MLX ranking, and faster replay.

Pros:

- directly targets profitability;
- builds on the current v6 whitepaper autoresearch and strategy-factory work.

Cons:

- can create more candidates than the control plane can safely prove;
- stale tape or timed-out quant health can still produce false confidence;
- does not reduce Jangar rollout or runtime failure modes.

Decision: rejected for this phase.

### Option C: Cross-Plane Evidence Epochs and Profit Cells

Summary:

- Bind Jangar admission, Torghut runtime readiness, data freshness, image portability, and post-cost evidence into one
  epoch.
- Settle each hypothesis/account/window into a profit cell that can fund observe, probe, canary, or live capital.
- Let MLX and strategy factory run inside the epoch, but never let them approve promotion by themselves.

Pros:

- reduces false promotion paths;
- makes data freshness and image portability part of profitability evidence;
- supports hypothesis-local degradation instead of global blocks;
- creates a precise handoff contract for engineer and deployer stages.

Cons:

- adds additive schema and route work before new capital can be enabled;
- makes some research output wait for evidence receipts;
- requires careful test coverage across Jangar and Torghut.

Decision: selected.

## Decision

Adopt Option C.

The selected architecture introduces two linked authority objects:

1. `EvidenceEpoch`
   - produced by Jangar and mirrored by Torghut;
   - proves runtime kit completeness, controller rollout state, quant route health, data projection freshness, and image
     portability for a bounded time window.
2. `ProfitCell`
   - produced by Torghut for each `hypothesis_id`, `account`, `window`, and `stage`;
   - proves post-cost PnL evidence, capacity, concentration, drawdown, slippage, source freshness, and rollback
     readiness.

No non-observe capital move can happen unless the profit cell cites a fresh evidence epoch.

## Target Contracts

### Evidence Epoch

Fields:

- `evidence_epoch_id`
- `jangar_epoch_id`
- `torghut_runtime_revision`
- `torghut_image_digest`
- `image_platform_receipt`
- `data_warrant_digest`
- `quant_pipeline_digest`
- `market_context_digest`
- `readiness_digest`
- `decision`: `allow`, `degrade`, `quarantine`, or `block`
- `reason_codes`
- `issued_at`
- `fresh_until`

Rules:

- Missing image platform support is `block` for sim rollout and non-observe promotion.
- `/healthz` alone can never produce `allow`.
- `/readyz`, `/trading/status`, Jangar quant health, and Jangar control-plane status must agree on the active epoch id.
- Expired epochs block canary/live and allow observe-only diagnostics.

### Profit Cell

Fields:

- `profit_cell_id`
- `evidence_epoch_id`
- `hypothesis_id`
- `strategy_family`
- `account`
- `window`
- `capital_stage`: `observe`, `probe`, `canary`, `live`, `scale`, or `quarantine`
- `post_cost_net_pnl`
- `daily_pnl_distribution`
- `max_drawdown`
- `best_day_share`
- `active_day_ratio`
- `capacity_notional`
- `slippage_bps`
- `data_freshness_warrant`
- `rollback_receipt`
- `decision`
- `reason_codes`

Rules:

- A portfolio can target `$500/day`, but each sleeve is evaluated by contribution, not raw standalone PnL.
- A sleeve can enter `probe` with degraded but explicit data warrants; it cannot enter `canary` or higher with expired
  warrants.
- Any best-day concentration, stale-tape, missing image-portability, or quant-health timeout reason is a cell-local
  block unless the same evidence affects all cells.

## Measurable Trading Hypotheses

Hypothesis 1: Evidence-epoch admission reduces false promotion.

- Measure: zero non-observe promotion attempts without a fresh `evidence_epoch_id`.
- Gate: promotion tests inject `/readyz` timeout, Jangar quant-health timeout, and sim image-platform failure; all must
  block canary/live.
- Expected value: fewer capital exposures backed by stale or contradictory runtime truth.

Hypothesis 2: Profit cells improve portfolio profitability by funding contribution, not leaderboard rank.

- Measure: portfolio candidate targets at least `$500/day` post-cost net PnL with cell-level attribution.
- Gate: no cell can contribute more than the configured concentration cap, no cell can rely on one best day, and every
  cell must include source freshness.
- Expected value: better diversification and less overfit capital allocation.

Hypothesis 3: Hypothesis-local degradation preserves useful research throughput.

- Measure: a blocked ClickHouse or market-context segment blocks only cells that cite it, while unrelated observe/probe
  cells can continue.
- Gate: tests prove stale `ta_signals` does not block a fundamentals-only observe cell, and stale fundamentals does not
  block a pure microstructure observe cell.
- Expected value: less global downtime without weakening promotion safety.

Hypothesis 4: Image portability as profit evidence reduces simulation/live divergence.

- Measure: every promoted sim and live image has a platform receipt matching the schedulable node classes.
- Gate: the `sha256:d278a4d...` style platform mismatch observed in this run would block promotion before rollout.
- Expected value: fewer cases where a profitable simulation is not reproducible across the actual cluster.

## Implementation Scope

Engineer scope:

1. Add Torghut evidence epoch mirror models and serializers.
2. Add profit-cell models under the autonomy/discovery boundary without expanding `policy_checks.py` into another
   monolith.
3. Add route projections so `/readyz`, `/trading/status`, and promotion checks expose the same active epoch id.
4. Add image platform receipt generation in build/deploy verification and consume it in Torghut readiness.
5. Add bounded data warrants for Postgres, ClickHouse, quant metrics, market context, and empirical jobs.
6. Update strategy factory and MLX autoresearch outputs to write candidate evidence into profit cells instead of
   declaring promotion authority directly.
7. Add Jangar consumer receipt ingestion so Torghut can read the latest admission decision without timing out on a hot
   path.

Non-goals:

- no live capital enablement in the first implementation PR;
- no privileged database shell dependency in normal verification;
- no direct mutation of cluster resources from the design or verification lane;
- no broad rewrite of the strategy factory.

## Validation Gates

Required implementation checks:

1. Unit tests:
   - evidence epoch blocks canary/live when `/readyz` times out;
   - evidence epoch blocks canary/live when Jangar quant health times out;
   - evidence epoch blocks sim promotion when image platform receipt is missing;
   - profit cell blocks stale tape, best-day concentration, and expired data warrants;
   - unrelated observe cells continue when a different segment is degraded.
2. Route tests:
   - `/readyz` and `/trading/status` expose the same `evidence_epoch_id`;
   - promotion status lists cell-local block reasons;
   - Jangar consumer receipt expiry is visible and fail-closed.
3. Data projection tests:
   - Jangar quant latest-store status and pipeline health can be summarized without unbounded raw queries;
   - Torghut data warrants use bounded windows and explicit freshness timestamps.
4. Rollout verification:
   - image-platform receipt matches all schedulable node classes for Torghut and Torghut sim;
   - deployment verification fails before the cluster reaches `ImagePullBackOff`.
5. Profitability validation:
   - portfolio summary includes post-cost net PnL, drawdown, capacity, slippage, concentration, and per-cell
     contribution;
   - `$500/day` is accepted only as a portfolio objective with cell-level guardrails.

## Rollout Plan

Wave 1: shadow receipts.

- Produce evidence epochs and profit cells from existing data.
- Do not enforce promotion decisions yet.
- Compare receipt decisions against current promotion and readiness answers.

Wave 2: readiness parity.

- Make `/readyz`, `/trading/status`, and Jangar quant-control routes cite the same epoch.
- Keep observe-only research active.
- Alert on mismatched or expired epoch ids.

Wave 3: promotion enforcement.

- Require fresh evidence epochs and profit cells for probe and canary.
- Keep live and scale disabled until deployer signs off on image portability and data warrants.

Wave 4: portfolio governor.

- Let MLX and strategy factory propose portfolios.
- Fund only cells whose evidence and guardrails pass.
- Promote by portfolio contribution and risk budget, not single-strategy rank.

## Rollback Plan

Rollback must avoid unsafe optimism:

1. Disable enforcement by feature flag and keep shadow receipt generation active.
2. Treat missing or expired evidence epochs as `block` for non-observe capital.
3. Keep current observe-only diagnostics available.
4. Revoke profit cells whose data warrants or image receipts were produced by the faulty release.
5. Roll forward with repaired receipt compilation instead of deleting historical evidence.

## Risks and Mitigations

- Risk: receipt generation adds latency to hot paths.
  - Mitigation: compute receipts asynchronously and serve compact latest projections.
- Risk: profit cells become another leaderboard.
  - Mitigation: require contribution, capacity, concentration, drawdown, and freshness fields before any capital stage.
- Risk: data warrants hide bad raw data behind a green summary.
  - Mitigation: warrants must include bounded query windows, source timestamps, and reason codes for degraded state.
- Risk: rollout enforcement blocks too much research during early adoption.
  - Mitigation: observe-only and probe-only modes remain available when their local evidence is explicit.
- Risk: the system overfits to the current ImagePullBackOff incident.
  - Mitigation: image portability is one field in a broader receipt chain, not the whole design.

## Handoff to Engineer and Deployer

Engineer acceptance gates:

- Implement additive evidence epoch and profit-cell contracts.
- Keep tests focused on receipt decisions and route parity.
- Avoid privileged database shell assumptions.
- Keep the first implementation wave shadow-only.

Deployer acceptance gates:

- Confirm Torghut and Torghut sim images have platform receipts for schedulable node classes.
- Confirm `/readyz`, `/trading/status`, Jangar quant health, and Jangar control-plane status cite the same epoch.
- Confirm stale or unreachable data authorities block only affected cells.
- Confirm no canary/live capital is enabled until evidence epochs and profit cells are fresh and enforcement is active.

## Current Open Risks

- The worker could not directly query Torghut Postgres or ClickHouse due RBAC/authentication limits.
- `uv` was unavailable in this workspace, so local migration graph validation could not run.
- Jangar memories returned `ECONNRESET`, so live memory retrieval was unavailable during assessment.
- NATS collaboration worked only after installing the missing local `nats` CLI; Jangar's own runtime status still
  reports `runtime_kit_component_missing:nats_cli` for collaboration classes.
