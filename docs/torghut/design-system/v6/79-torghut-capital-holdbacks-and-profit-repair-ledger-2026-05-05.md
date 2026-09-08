# 79. Torghut Capital Holdbacks and Profit Repair Ledger

Status: Accepted for implementation planning

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

Torghut should consume Jangar failure-domain leases as capital holdbacks and maintain a Profit Repair Ledger that ranks
blocked hypotheses by expected repair value. I am choosing this direction because the current state has two truths that
must not be confused: Torghut can keep some runtime pods alive, but the Jangar and Postgres authority paths needed for
promotion are not routable enough to spend capital.

The profit move is not "trade less forever." The profit move is to stop letting stale or unreachable control-plane
authority leak into capital decisions, while preserving observe/shadow collection and using the blocked evidence to
prioritize the repairs most likely to restore profitable hypotheses. A held hypothesis should produce a repair ticket
with a measurable economic hypothesis, not just a red status badge.

The tradeoff is that Torghut will hold capital when Jangar dependency leases, Torghut database leases, or proof
freshness leases are expired. That can delay a profitable opportunity. It is still better than promoting on stale
empirical evidence, unreachable schema authority, or a Jangar control plane that cannot prove its own database
routability.

## Runtime Inputs

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- Jangar swarm: `jangar-control-plane`
- Torghut objective: increase profitability with measurable trading hypotheses and guardrails.

Success means Torghut has a concrete consumer contract for Jangar leases, a measurable repair-prioritization model,
and deployment gates that distinguish observe/shadow evidence collection from non-shadow capital admission.

## Evidence Captured

All checks were read-only.

### Cluster and Rollout

Torghut namespace:

- `kubectl -n torghut get pods -o wide` showed live Torghut, simulation, ClickHouse, Keeper, options, TA, websocket,
  DB, exporters, and Symphony pods running.
- `torghut-00207-deployment-7bc684fdbd-h2qk7` was `2/2 Running`.
- `torghut-sim-00285-deployment-79c766d7b8-54hqc` was `2/2 Running`.
- Two recent `torghut-sim-owner-repair-20260505-*` jobs were in `Error`.
- `torghut-ws-options` had restarted once 136 minutes before assessment.
- `torghut-db-1` was container-ready but pod-ready false, terminating, and marked `DisruptionTarget=True`.

Jangar dependency surface:

- Jangar route probes to `http://jangar.jangar.svc.cluster.local/health` and `/api/health` failed to connect.
- Jangar DB service refused connections.
- Agents rollout had new promoted replicas stuck in image pull failure while old replicas remained running.
- NATS publish worked, but stream inspection timed out.

Route evidence:

- `curl http://torghut.torghut.svc.cluster.local/trading/status` timed out after 8 seconds from this runtime.
- `curl http://torghut.torghut.svc.cluster.local/health` also timed out after 8 seconds from this runtime.
- The timeout is materially different from prior healthy route evidence in earlier Torghut docs. The architecture must
  therefore treat route reachability as lease-bound evidence, not as an assumed fact.

RBAC and database evidence:

- `kubectl cnpg psql` failed in both `jangar` and `torghut` because this service account cannot create `pods/exec`.
- Jangar and Torghut application DSNs were readable from Kubernetes Secrets, but Postgres service or pod-IP connection
  attempts refused or timed out.
- ClickHouse pods were running, but direct HTTP query attempts returned `403`, so this runtime could not validate
  ClickHouse data freshness through direct SQL either.

### Source and Test Surface

Torghut source has the right ingredients but not the selected holdback/repair contract:

- `services/torghut/app/main.py` is 3978 lines and assembles health, readiness, database contract, hypothesis runtime,
  empirical jobs, live-submission gate, trading status, and route payloads.
- `services/torghut/app/trading/submission_council.py` is 1196 lines and already speaks the language of capital
  stages, quant evidence, empirical jobs, Jangar dependency quorum, and segment summaries.
- `services/torghut/app/trading/hypotheses.py` is 732 lines and already models dependency capabilities including
  `jangar_dependency_quorum`, `signal_continuity`, `drift_governance`, `feature_coverage`,
  `market_context_freshness`, and `evidence_continuity`.
- `services/torghut/app/db.py` is 483 lines and already checks schema heads, graph signatures, orphan parents,
  duplicate revisions, and account-scoped trading invariants.
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py` adds persistent hypothesis governance
  and metric window tables.
- `services/torghut/migrations/versions/0029_whitepaper_embedding_dimension_4096.py` keeps whitepaper semantic
  embeddings at `vector(4096)`.
- `services/torghut/tests` contains broad coverage for hypotheses, profitability evidence, archive-backed proof,
  governance policy, simulation parity, execution policy, order firewall, runtime windows, and readiness.

The gap is cross-plane parity under degraded infrastructure:

- Tests prove many local contracts.
- They do not prove that Jangar failure-domain leases, Torghut database routability, route timeout, ClickHouse query
  access, and hypothesis economic gates settle into one capital holdback with a repair priority.

### Database, Data Freshness, and Consistency

Because Postgres and ClickHouse were not queryable from this runtime, live data freshness could not be established by
direct SQL. That is not a reason to ignore the data plane; it is the reason to make routability a first-class capital
gate.

Source-known data contracts:

- Torghut expects Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Hypothesis governance stores expected edge, slippage budgets, sample counts, drawdown budgets, dependency quorum
  decisions, capital stages, and payload evidence.
- Jangar has a Torghut quant cache schema for `quant_metrics_latest`, `quant_metrics_series`, `quant_alerts`, and
  `quant_pipeline_health`.
- Jangar has market-context snapshots, dispatch state, run lifecycle, evidence, and run-event tables.

Current consistency state:

- Database container readiness was not enough to prove route consistency.
- Route timeout was not enough to prove Torghut is down; pods were running.
- The safe capital decision is therefore `hold`, while observe/shadow evidence collection remains allowed only where
  its required data leases are valid.

## Problem

Torghut profitability depends on fresh economic evidence, not just live service shape. The current system can be
operationally alive but economically unauthoritative:

- Jangar dependency status can be unreachable or stale while Torghut needs it for promotion.
- Torghut Postgres can have a running container while the pod is terminating and the service is unroutable.
- ClickHouse can run while this runtime cannot query it.
- Route status can time out while pods remain running.
- Hypothesis governance can encode expected edge and rollback triggers, but no single repair ledger ranks what to fix
  when capital is held.

Without a capital holdback and repair ledger, the organization either over-blocks everything or takes informal risks.
Neither path improves profitability over the next six months.

## Profit Hypotheses

This architecture defines measurable hypotheses for the engineer and deployer stages:

1. Capital holdback reduces false-positive promotion.
   - Hypothesis: requiring valid Jangar, Torghut database, route, proof freshness, and rollback leases before non-shadow
     capital will reduce promotions later reversed for stale data or infrastructure authority to zero.
   - Metric: count of non-shadow promotions with any expired lease at promotion time.
   - Guardrail: no non-shadow capital if `expired_lease_count > 0` for the account/window.

2. Profit Repair Ledger improves time-to-profitable-recovery.
   - Hypothesis: ranking blocked hypotheses by expected repair value will restore profitable shadow/canary candidates
     faster than first-in-first-out repair.
   - Metric: median time from holdback open to valid proof receipt, segmented by repair reason.
   - Economic score: expected post-cost daily PnL restored minus estimated repair cost and opportunity risk.
   - Guardrail: repair jobs cannot mutate live capital state.

3. Lease-aware observe mode preserves option value.
   - Hypothesis: allowing observe/shadow evidence collection under scoped valid data leases will keep research signal
     throughput while preventing unsafe capital.
   - Metric: observe/shadow evidence windows collected during capital holdbacks and later accepted into proof receipts.
   - Guardrail: observe evidence collected while database or route lease is expired must carry a degraded provenance
     mark and cannot promote without revalidation.

## Options Considered

### Option A: Global Capital Freeze on Jangar or Torghut Degradation

Any degraded Jangar dependency, Torghut route timeout, or database uncertainty freezes all Torghut autonomy and
evidence collection.

Pros:

- Strongest immediate protection.
- Simple operational rule.
- Low implementation ambiguity.

Cons:

- Throws away observe/shadow evidence even when local data leases are valid.
- Does not prioritize repair.
- Slows strategy discovery and makes profitability recovery reactive.

Decision: reject as steady-state architecture; keep as emergency kill-switch behavior.

### Option B: Local Torghut Proof Only

Ignore Jangar leases for capital and rely on Torghut local database, hypothesis, TCA, empirical job, and route status
contracts.

Pros:

- Faster local implementation.
- Less coupling to Jangar availability.
- Reuses existing Torghut route and source contracts.

Cons:

- Misses the Jangar control-plane authority required for cross-swarm promotion and deploy safety.
- Cannot explain whether stale Jangar dependency was part of a capital decision.
- Leaves downstream visibility and handoff fragmented.

Decision: reject. Torghut can be locally healthy and still unsafe to promote when Jangar authority is expired.

### Option C: Capital Holdbacks plus Profit Repair Ledger

Consume Jangar Failure-Domain Leases and Torghut data/proof leases to hold capital by account/window/hypothesis. Record
each holdback in a Profit Repair Ledger and rank repair work by expected economic value.

Pros:

- Blocks unsafe capital without stopping useful observe/shadow work.
- Gives every holdback an economic reason and a repair owner.
- Turns stale infrastructure/data evidence into prioritized profit recovery work.
- Aligns Torghut routes, scheduler, Jangar mirror, and deployer handoff around one receipt.

Cons:

- Requires new persisted or materialized holdback receipts.
- Requires route parity tests across readiness, status, scheduler, and Jangar quant mirrors.
- Requires careful scoring so the ledger does not pretend estimated repair value is realized PnL.

Decision: select Option C.

## Chosen Architecture

### 1. CapitalHoldbackReceipt

Create a `CapitalHoldbackReceipt` for each account/window/hypothesis where non-shadow capital is not allowed.

Required fields:

- `holdback_id`
- `account`
- `window`
- `hypothesis_id`
- `capital_stage_requested`
- `capital_stage_allowed`
- `opened_at`
- `expires_at`
- `jangar_lease_digest`
- `torghut_database_lease_id`
- `torghut_route_lease_id`
- `proof_freshness_lease_id`
- `rollback_lease_id`
- `reason_codes`
- `evidence_refs`
- `repair_priority_score`
- `repair_owner`
- `close_conditions`

Capital is allowed beyond shadow only when no unexpired holdback receipt exists for the account/window/hypothesis and
all required leases are valid.

### 2. ProfitRepairLedger

The ledger ranks repair work by expected profit restoration, not by alert age.

Initial scoring:

- `expected_daily_pnl_restored`
- `confidence`
- `days_blocked`
- `capital_stage_requested`
- `sample_count`
- `slippage_gap_bps`
- `data_staleness_seconds`
- `repair_cost_class`
- `blast_radius`

Score formula for the first implementation:

`repair_priority_score = expected_daily_pnl_restored * confidence * min(days_blocked, 5) - repair_cost_penalty - blast_radius_penalty`

The formula is intentionally simple. The important rule is that the ledger must store the inputs and the formula
version, so profitability claims can be falsified later.

### 3. Lease Consumers

Torghut should consume these leases:

- Jangar dependency lease:
  - Required for capital promotion and deployer handoff.
  - Expired when Jangar route, DB, rollout, or NATS replay authority is expired for the relevant action class.
- Torghut database lease:
  - Required for promotion, proof settlement, and scheduler live submission.
  - Expired when Postgres service query fails, schema head cannot be proven, or pod state is disrupted.
- Torghut route lease:
  - Required for route parity and operator visibility.
  - Route timeout holds capital but can allow offline repair jobs.
- Proof freshness lease:
  - Required for empirical jobs, TCA, quant health, signal continuity, market context, and drift evidence.
- Rollback lease:
  - Required before moving from shadow to any canary/live stage.

### 4. Route and Scheduler Parity

The following surfaces must cite the same active holdback receipt:

- `/readyz`
- `/trading/status`
- `/trading/health`
- scheduler live-submission gate
- Jangar Torghut quant health mirror
- deployer handoff message

If a route cannot reach the receipt store, it must return `holdback_status=unknown` and must not allow capital.

### 5. Observe and Shadow During Holdback

Holdback blocks capital, not learning.

Allowed under scoped valid leases:

- observe evidence collection
- shadow decisions
- replay and simulation runs
- repair verification
- artifact compilation

Blocked:

- canary/live capital
- scheduler live submission
- deployer rollout widening tied to capital movement
- promotion certificates

Evidence collected during holdback must include provenance:

- `collected_under_holdback=true`
- active holdback ids
- invalid or expired leases at collection time
- revalidation requirement before promotion

## Implementation Scope

Engineer stage:

- Add `CapitalHoldbackReceipt` and `ProfitRepairLedger` contracts.
- Materialize holdbacks from Jangar failure-domain lease digest plus Torghut database, route, proof, and rollback
  leases.
- Wire the active holdback id into Torghut readiness/status/health, scheduler submission gate, and Jangar mirror
  payloads.
- Add route parity tests proving every route cites the same holdback for the same account/window/hypothesis.
- Add repair-priority tests proving score inputs and formula version are persisted and reproducible.

Likely source files:

- `services/torghut/app/main.py`
- `services/torghut/app/trading/submission_council.py`
- `services/torghut/app/trading/hypotheses.py`
- `services/torghut/app/trading/completion.py`
- `services/torghut/app/db.py`
- `services/torghut/app/models/entities.py`
- `services/torghut/migrations/versions/*`
- `services/jangar/src/server/torghut-quant-metrics-store.ts`
- `services/jangar/src/server/torghut-trading.ts`

Deployer stage:

- Do not promote non-shadow capital unless active holdback count is zero for the target account/window/hypothesis.
- Publish holdback ids, lease digest, repair priority, and rollback target in NATS handoff.
- Roll back capital stage to shadow if any required lease expires during canary/live soak.

## Validation Gates

Tests:

- Torghut route parity: `/readyz`, `/trading/status`, `/trading/health`, and scheduler gate return the same active
  holdback id.
- Jangar mirror parity: Jangar quant health cites the same holdback id and Jangar lease digest.
- Capital block: expired Jangar lease blocks canary/live even when local Torghut route is healthy.
- Observe allowance: shadow/observe evidence can be recorded under holdback with degraded provenance.
- Repair ranking: priority score is deterministic from stored inputs and formula version.
- Rollback trigger: required lease expiry during canary/live emits rollback-required status.

Read-only deployment checks:

- `kubectl -n torghut get pods -o wide`
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -100`
- Torghut route probes for `/readyz`, `/trading/status`, `/trading/health`
- Jangar lease digest probe
- Postgres read-only service probe
- ClickHouse read-only probe or route-backed freshness receipt

Acceptance gates:

- Non-shadow capital is impossible with expired Jangar, database, route, proof, or rollback leases.
- Shadow and observe evidence continue only when their scoped data leases are valid.
- Each holdback has a repair priority score and close conditions.
- Deployer handoff names the active holdback ids and rollback target.

## Rollout Plan

Phase 0: shadow holdback receipts.

- Compute holdbacks and repair scores without blocking capital beyond existing gates.
- Compare against current hypothesis state and operator decisions.

Phase 1: route parity.

- Surface active holdback ids on readiness, status, health, scheduler, and Jangar mirror routes.
- Do not allow unknown receipt state to promote capital.

Phase 2: capital enforcement.

- Block canary/live capital on active holdbacks.
- Preserve observe/shadow evidence with degraded provenance.

Phase 3: repair-priority scheduling.

- Feed the highest-value repair ledger items into Jangar engineer/deployer queues.
- Measure time-to-close and realized evidence improvement.

## Rollback Plan

- If holdbacks are too strict, disable enforcement but keep shadow receipt publication.
- If route parity breaks, fall back to existing local Torghut gates and mark Jangar mirror `unknown`; capital remains
  blocked until parity returns.
- If repair scores are misleading, freeze score-based prioritization and use reason-code ordering while retaining the
  ledger.
- If a canary/live stage sees any required lease expire, demote to shadow and preserve the holdback evidence.

## Risks and Mitigations

- Risk: repair score is mistaken for realized profit.
  - Mitigation: store formula version and inputs; realized PnL must be measured separately.
- Risk: Jangar outage blocks all Torghut progress.
  - Mitigation: block only capital; allow observe/shadow and scoped repair when local data leases are valid.
- Risk: holdback receipts add another source of truth.
  - Mitigation: make them the consumed route/scheduler contract, not an optional dashboard field.
- Risk: query access remains limited.
  - Mitigation: route-backed freshness receipts and lease digests are acceptable only when they include schema head,
    observed time, and issuer identity; otherwise they are `unknown`.

## Handoff Contract

Engineer acceptance:

- Implement holdback and repair-ledger data contracts with deterministic scoring.
- Add route and scheduler parity tests.
- Prove capital blocks on expired Jangar and database leases while observe/shadow remains available.

Deployer acceptance:

- Before any non-shadow promotion, verify zero active holdbacks for the target account/window/hypothesis.
- During soak, roll back to shadow if any required lease expires.
- Publish NATS handoff with holdback ids, lease digest, repair priority, rollback target, and the next validation
  command.
