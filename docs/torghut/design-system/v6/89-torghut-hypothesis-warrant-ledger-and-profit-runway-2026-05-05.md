# 89. Torghut Hypothesis Warrant Ledger and Profit Runway (2026-05-05)

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

Torghut should introduce a **Hypothesis Warrant Ledger** and a **Profit Runway** that consume Jangar evidence epochs.
Every hypothesis gets an explicit warrant before it can move from zero-notional replay to shadow, paper, live canary, or
scaled live. A warrant is not a strategy score. It is a short-lived capital permission tied to one Jangar epoch, one
dataset window, one hypothesis, and one rollback plan.

I am choosing this because the current service is alive but not ready to spend capital. Torghut is running in live mode,
schema proof is current, Postgres and ClickHouse route checks are healthy, the universe is fresh from Jangar, and the
market session is open. The capital evidence is still weak: live submission is disabled, all hypotheses are shadow or
blocked, promotion eligibility is zero, stale empirical jobs date back to 2026-03-21, and the last 72 hours show eight
rejected decisions with zero executions and zero TCA samples.

The profitable move is not to bypass `simple_submit_disabled`. The profitable move is to turn blocked capital into
session replay, measured shadow probes, and fresh empirical jobs until a hypothesis earns a paper warrant.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Route Evidence

- `kubectl get pods -n torghut -o wide` showed Torghut live revision `torghut-00219`, Torghut sim revision
  `torghut-sim-00300`, Postgres, ClickHouse, Flink task managers, options services, and exporters running.
- Torghut events showed recent Knative revisions becoming ready, but also startup/readiness probe failures, scheduling
  pressure for backfills, Flink checkpoint exceptions, and ClickHouse multiple-PDB warnings.
- `/healthz` returned ok.
- `/db-check` returned `ok=true`, `schema_current=true`, Alembic head `0029_whitepaper_embedding_dimension_4096`, and
  lineage ready with historical parent-fork warnings.
- `/trading/health` returned degraded because `live_submission_gate.ok=false` and `simple_submit_disabled`; scheduler,
  Postgres, ClickHouse, Alpaca, universe, empirical job route health, DSPy route status, and optional quant evidence
  were usable.
- `/trading/status` reported `mode=live`, active revision `torghut-00219`, `execution_lane=simple`,
  `capital_stage=shadow`, three hypotheses, zero promotion-eligible hypotheses, and three rollback-required
  hypotheses.
- `/trading/empirical-jobs` reported `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` as truthful but stale from `2026-03-21T09:03:22Z`.
- `/trading/profitability/runtime?hours=72` reported eight decisions, zero executions, zero TCA samples, zero realized
  PnL proxy, and no promotion target.

### Source and Data Evidence

- `services/torghut/app/main.py` exposes the operational proof routes: `/db-check`, `/trading/health`,
  `/trading/status`, `/trading/empirical-jobs`, and `/trading/profitability/runtime`.
- `services/torghut/app/trading/submission_council.py` already combines hypothesis readiness, empirical jobs, DSPy,
  quant evidence, dependency quorum, toggle parity, and promotion certificate evidence into the live submission gate.
- `services/torghut/app/trading/empirical_jobs.py` already distinguishes truthful empirical authority from stale jobs.
- `services/torghut/app/trading/profitability_archive.py` already has historical and paper readiness concepts that can
  feed runway warrants.
- Direct database shell access is not available in this runtime because `pods/exec` is forbidden. The warrant ledger
  must be validated through application route proof and read-only artifacts, not operator-only SQL.

## Problem

Torghut has many safety gates, but the capital path still does not convert blocked states into profitable work. A live
service can run with zero submit authority. A fresh schema can coexist with stale empirical evidence. A strategy can
produce rejected decisions without generating executions or TCA. A historical TCA table can be deep while the current
window is empty.

That creates two bad incentives: either wait passively for someone to refresh evidence, or bypass the gate to get new
samples. Both are wrong. The system needs a runway where blocked capital automatically becomes zero-notional replay and
shadow proof, while paper/live authority stays tied to fresh evidence.

## Alternatives Considered

### Option A: Enable Paper As Soon As Infrastructure Is Healthy

Use healthy schema, running pods, live mode, and fresh universe as enough proof to permit paper submissions.

Pros:

- quickly creates fresh execution and TCA samples;
- exercises broker and order-feed paths;
- reduces idle time.

Cons:

- ignores stale empirical jobs;
- ignores Jangar dependency quorum;
- can pollute the evidence base with weak paper samples;
- does not solve why eight recent decisions were rejected.

Decision: reject. Paper is cheap, but noisy paper can still mislead promotion.

### Option B: Keep All Capital Blocked Until Empirical Jobs Refresh

Hold replay, shadow, and paper until empirical jobs are fresh and dependency quorum is green.

Pros:

- clean capital safety posture;
- simple audit rule;
- no accidental market interaction.

Cons:

- wastes live market-session signal windows;
- does not generate route latency, rejection, or shadow behavior evidence;
- leaves stale empirical jobs as a dead end instead of a repair trigger.

Decision: reject as the normal path. Fresh empirical jobs are required for paper/live, not for replay.

### Option C: Hypothesis Warrant Ledger And Profit Runway

Create a capital warrant per hypothesis and stage. Use Jangar evidence epochs for external authority, Torghut route
proof for local health, and profit SLOs for promotion.

Pros:

- turns blocked capital into replay and shadow evidence;
- keeps paper/live authority tied to fresh Jangar and empirical proof;
- makes each hypothesis measurable and falsifiable;
- separates observational evidence from executable evidence;
- gives deployers one rollback handle per warrant.

Cons:

- adds persistence and route work;
- requires careful handling so replay is not overclaimed as profitability;
- slows promotion until each hypothesis earns samples under the current market regime.

Decision: select Option C.

## Chosen Architecture

### Hypothesis Warrant

```text
hypothesis_warrant
  warrant_id
  jangar_epoch_id
  hypothesis_id
  strategy_family
  account_label
  capital_stage              # zero_notional_replay, shadow_probe, paper_probe, live_canary, scaled_live
  dataset_snapshot_ref
  session_window_start
  session_window_end
  decision                   # allow, hold, block
  reason_codes[]
  profit_slo_ref
  rollback_ref
  issued_at
  expires_at
```

The warrant is the only object that can raise capital stage. Local Torghut readiness may lower a warrant, but it cannot
raise paper/live authority above the Jangar epoch gate.

### Profit Runway

Each hypothesis moves through the same runway:

1. `zero_notional_replay`: no orders, deterministic replay, explicit fill assumptions.
2. `shadow_probe`: live signals and decisions, no broker submission.
3. `paper_probe`: broker paper submission, TCA required, capital multiplier remains zero for live.
4. `live_canary`: smallest live multiplier, automatic rollback on any guardrail breach.
5. `scaled_live`: only after repeated canary windows and deployer signoff.

### Initial Hypothesis Warrants

Current route evidence supports these initial states:

- `H-CONT-01`, continuation:
  - start at `zero_notional_replay`;
  - require fresh empirical jobs for paper;
  - require at least 40 paper samples for live canary;
  - require post-cost expectancy at or above 6 bps;
  - require average absolute slippage at or below 12 bps;
  - block on signal lag or Jangar dependency quorum.
- `H-MICRO-01`, microstructure breakout:
  - remain blocked until feature coverage and drift governance are present;
  - require at least 60 paper samples for live canary and 120 for scale-up;
  - require post-cost expectancy at or above 10 bps;
  - require average absolute slippage at or below 8 bps;
  - block when feature rows or drift checks are missing.
- `H-REV-01`, event reversion:
  - start at `zero_notional_replay`;
  - require market-context freshness inside 120 seconds;
  - require at least 30 paper samples for live canary;
  - require post-cost expectancy at or above 8 bps;
  - require average absolute slippage at or below 12 bps.

These are admission standards, not profit promises.

### Replay Receipts

While paper/live warrants are held, Torghut should emit replay receipts:

```text
session_replay_receipt
  receipt_id
  warrant_id
  hypothesis_id
  jangar_epoch_id
  market_session
  signal_count
  decision_count
  rejection_counts
  assumed_fill_model
  expected_post_cost_bps
  feature_coverage
  market_context_freshness_seconds
  empirical_job_blockers[]
  next_repair_action
```

Replay receipts are useful for repair and hypothesis ranking. They cannot satisfy paper or live execution gates without
fresh empirical jobs and paper samples.

## Implementation Scope

Phase 0, observe-only:

- Add a route projection for active hypothesis warrants and the consumed Jangar epoch id.
- Emit warrant decisions from current `/trading/status`, `/trading/health`, empirical jobs, and runtime profitability
  evidence.
- Keep broker submission behavior unchanged.

Phase 1, replay governor:

- Generate zero-notional replay receipts during market sessions when empirical jobs or Jangar gates block paper/live.
- Attribute rejected decisions by hypothesis, symbol, strategy id, and rejection reason.
- Trigger empirical refresh requests when stale jobs are the blocker.

Phase 2, shadow and paper warrants:

- Allow shadow probes when replay receipts are fresh, non-empty, and route proof is current.
- Allow paper warrants only when Jangar `paper_submit` is allow, empirical jobs are fresh for the candidate/dataset, and
  hypothesis SLOs pass.
- Require TCA coverage and rollback dry-runs before live canary.

Phase 3, live canary:

- Start with the smallest capital multiplier.
- Roll back automatically on dependency quorum hold, stale empirical proof, slippage breach, drawdown breach, route
  proof expiration, or Jangar `live_submit` hold/block.

## Validation Gates

Engineer acceptance:

- Tests prove stale empirical jobs create replay warrants but hold paper/live warrants.
- Tests prove zero executions and zero TCA samples cannot satisfy paper-to-live gates.
- Tests prove dependency quorum block lowers all paper/live warrants regardless of local Torghut health.
- Tests prove each hypothesis emits distinct reason codes for signal lag, feature coverage, market context freshness,
  drift checks, slippage, and sample count.
- Route tests prove `/trading/status`, `/trading/health`, and the warrant projection cite the same Jangar epoch id.

Deployer acceptance:

- Observe-only rollout shows warrant decisions for all three current hypotheses without changing broker submission.
- A market-session replay sample produces receipts for continuation and event reversion while microstructure remains
  blocked for missing feature/drift proof.
- Paper remains held until empirical jobs are refreshed and the Jangar `paper_submit` gate is allow.
- Rollback drill proves disabling warrant enforcement returns Torghut to the existing live submission gate.

## Rollout And Rollback

Rollout:

1. Add observe-only warrant projection and replay receipt creation.
2. Add Jangar epoch consumption and parity checks.
3. Enable replay governor for market sessions.
4. Enable shadow warrant enforcement.
5. Enable paper warrants only after empirical refresh and Jangar paper gate parity.
6. Enable live canary only after paper sample and rollback evidence pass.

Rollback:

- Disable warrant enforcement and keep the current live submission gate as the only broker guard.
- Continue writing replay receipts if they are healthy; disable receipt writes if they affect route latency.
- Force all paper/live warrants to `hold` if Jangar epoch parity is missing.
- Disable live canary immediately through the existing kill switch and strategy-disable path.

## Risks

- Replay evidence can look more precise than it is. Mitigation: every replay receipt must carry fill assumptions and
  cannot satisfy paper/live gates alone.
- The warrant ledger could lag live status. Mitigation: warrants expire quickly and routes must reject expired warrants.
- Empirical refresh could become a bottleneck. Mitigation: stale jobs open repair work with explicit candidate and
  dataset refs instead of blocking silently.
- Paper samples can still be unprofitable. Mitigation: hypothesis SLOs include post-cost expectancy, slippage, sample
  count, drawdown, rejection rate, and rollback dry-runs.

## Handoff

Engineer stage owns warrant schema, route projection, replay receipts, Jangar epoch consumption, and regression tests.

Deployer stage owns observe-only rollout, route latency budgets, market-session replay validation, paper hold
verification, and rollback drills.

No Torghut paper or live capital should be authorized from local liveness, schema currency, or historical TCA depth
alone. Capital moves only when a fresh Jangar epoch, a valid hypothesis warrant, fresh empirical jobs, and the
hypothesis profit SLO agree.
