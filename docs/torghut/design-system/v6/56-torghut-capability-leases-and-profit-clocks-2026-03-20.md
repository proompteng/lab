# 56. Torghut Capability Leases and Profit Clocks (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Related mission: `codex/swarm-jangar-control-plane-discover`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`

Extends:

- `53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`
- `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
- `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`

## Executive summary

The decision is to stop letting Torghut infer Jangar dependency authority from URL families and route-local fetches.
Torghut will consume typed **Capability Leases** issued from Jangar authority capsules, then use lane-local
**Profit Clocks** to decide whether a hypothesis may remain in `shadow`, advance to canary, or be forced back to
`observe`.

The reason is visible in the live state on `2026-03-20`:

- `curl -sS http://torghut.torghut.svc.cluster.local/trading/status`
  - reports `live_submission_gate.allowed=false`
  - reports `blocked_reasons` including `dependency_quorum_block`, `empirical_jobs_not_ready`, and
    `quant_health_fetch_failed`
  - reports `quant_evidence.source_url="http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?account=PA3SX7FYNUTF&window=15m"`
- `curl -sS http://torghut.torghut.svc.cluster.local/readyz`
  - reports `quant_evidence.ok=false`
  - reports `quant_evidence.detail="quant_health_fetch_failed"`
  - reports `live_submission_gate.capital_stage="shadow"`
- `curl -sS "http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=1d"`
  - reports `status="degraded"`
  - reports `latestMetricsCount=0`
  - reports `emptyLatestStoreAlarm=true`
- `curl -sS "http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA"`
  - reports `overallState="down"`
  - reports stale fundamentals and news
  - reports technicals and regime errors
- `curl -sS http://torghut.torghut.svc.cluster.local/db-check`
  - reports `schema_current=true`
  - reports a healthy head at `0025_widen_lean_shadow_parity_status`

The tradeoff is more lease persistence, more expiry handling, and stricter scheduler/status parity rules. That is the
correct trade because the present failure is not missing data; it is that Torghut can still point at the wrong Jangar
surface and call the result authority.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarmName: `jangar-control-plane`
- swarmStage: `discover`
- objective: improve Jangar resilience and Torghut profitability with merged architecture outputs

This artifact succeeds when:

1. Torghut consumes typed Jangar capability truth instead of path-derived HTTP fallbacks;
2. scheduler, `/readyz`, and `/trading/status` share the same capability-lease and profit-clock state;
3. stale or missing Jangar evidence deallocates only the affected lanes;
4. engineer and deployer stages receive explicit validation, rollout, and rollback gates.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

The live runtime shows Torghut already failing closed, but for the wrong operational reason:

- the submission gate is blocked, which is safe;
- the quant-evidence failure is caused by endpoint ambiguity, which is avoidable;
- empirical jobs and forecast readiness are degraded, which should remain lane-local blockers;
- schema health is fine, so persistence is not the blocker.

That means the next step should not be to relax the gate. It should be to make the gate more authoritative and more
precise.

### Source architecture and high-risk modules

The source tree shows where the ambiguity comes from:

- `services/torghut/app/trading/submission_council.py`
  - `resolve_quant_health_url()` falls back from explicit quant-health wiring to other Jangar URLs;
  - before the fix in this PR, that fallback preserved the path from `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`;
  - the live payload proves that the generic control-plane path can therefore masquerade as quant authority.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still constructs live-submission truth inside the scheduler runtime;
  - that is correct only if it consumes one durable lease set, not if it performs endpoint inference itself.
- `services/torghut/app/main.py`
  - `/readyz` and `/trading/status` both expose the live-submission gate;
  - those routes must remain projections of the same lease and clock state used by the scheduler.

Current missing regression coverage:

- no test proving the control-plane-status fallback is rewritten to the quant-health endpoint;
- no test proving scheduler and route paths share the same lease digest;
- no test proving lane-local blockers do not deallocate unrelated hypotheses;
- no test proving a stale Jangar lease expires capital without turning every capability into a global outage.

### Database, schema, and data evidence

The data surfaces are good enough to hold the new contracts:

- `db-check` reports the schema is current;
- `trading/status` already persists enough hypothesis and readiness state to support profit clocks;
- Jangar quant-health and market-context APIs already expose the raw facts needed to issue leases.

The missing primitive is a durable bridge between those facts and the scheduler.

## Problem statement

Torghut still has four profitability-critical gaps:

1. it derives critical Jangar capability truth from URL heuristics instead of one typed lease;
2. scheduler and route surfaces can only stay aligned as long as they repeat the same endpoint logic;
3. stale Jangar evidence does not yet map cleanly to lane-local expiry and deallocation;
4. deployers cannot prove that the same authority object blocked both status and runtime.

That blocks safe profitability expansion because every new lane depends on fragile control-plane coupling.

## Alternatives considered

### Option A: keep HTTP pull and just require an explicit quant-health URL everywhere

Summary:

- remove fallback inference;
- force operators to configure `TRADING_JANGAR_QUANT_HEALTH_URL`.

Pros:

- smallest runtime delta;
- easy to explain.

Cons:

- still leaves Torghut on one-off route fetches;
- does not solve parity between scheduler and status;
- does not create durable lane-local expiry semantics.

Decision: rejected.

### Option B: mirror the full Jangar control-plane payload into Torghut and infer locally

Summary:

- ingest the full Jangar status payload;
- let Torghut compute lane truth from it.

Pros:

- fewer cross-service API calls during runtime;
- keeps Torghut self-contained.

Cons:

- recreates the same authority-reduction problem inside Torghut;
- turns one Jangar summary into an even larger Torghut dependency;
- still does not express lane-local lease expiry cleanly.

Decision: rejected.

### Option C: typed capability leases plus lane-local profit clocks

Summary:

- Jangar publishes typed capability leases derived from authority capsules;
- Torghut binds hypotheses to those leases and advances capital through profit clocks;
- scheduler and routes read the same lease and clock rows.

Pros:

- makes wrong-endpoint authority structurally impossible;
- cleanly supports lane-local degradation and expiry;
- aligns runtime, status, and deploy verification on one durable contract;
- increases option value for more hypothesis families and evidence sources.

Cons:

- adds schema and lease-compiler work;
- requires dual-read cutover and parity checks.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut should not decide capital posture from whichever Jangar endpoint happens to be configured. It should consume one
typed lease set and one profit-clock state that already encode what Jangar was willing to attest.

## Proposed architecture

### 1. Capability lease ledger

Add additive Torghut persistence:

- `capability_leases`
  - `lease_id`
  - `lease_kind` in `{quant_health, market_context, execution_trust, empirical_jobs, forecast_ready, options_bootstrap}`
  - `lane_id`
  - `subject_ref`
  - `source_capsule_id`
  - `decision` in `{healthy, hold, block, unknown}`
  - `observed_at`
  - `fresh_until`
  - `evidence_digest`
  - `reason_codes_json`
  - `payload_json`
- `capability_lease_events`
  - immutable append-only history of `issued`, `renewed`, `expired`, `superseded`, and `revoked`

Only the lease layer may translate Jangar authority into Torghut capability truth.

### 2. Profit clocks

Add lane-local capital state:

- `profit_clocks`
  - key: `{hypothesis_id, lane_id, account_label, window}`
  - `capital_state` in `{observe, shadow, canary, live, quarantine}`
  - `required_lease_digest`
  - `last_profit_evidence_digest`
  - `issued_at`
  - `expires_at`
  - `rollback_required`
  - `reason_codes_json`

Profit clocks are the only objects allowed to advance or deallocate non-shadow capital.

### 3. Binding contract

Introduce one explicit Torghut binding to Jangar capability truth:

- `TRADING_JANGAR_CAPABILITY_LEASE_URL` for the authoritative lease feed or snapshot;
- scheduler, `/readyz`, and `/trading/status` must all read the same lease rows, not recreate fetch logic;
- hypothesis manifests declare required lease kinds so options-lane failures only deallocate options-dependent lanes.

### 4. Immediate slice landed in this PR

This PR carries one concrete runtime fix that aligns with the design:

- `services/torghut/app/trading/submission_council.py`
  - now rewrites `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` and `TRADING_MARKET_CONTEXT_URL` fallbacks to the quant
    health path instead of preserving the wrong source path;
  - this removes the live `quant_health_fetch_failed` authority bug caused by path reuse.
- `services/torghut/tests/test_submission_council.py`
  - now contains regression coverage for both fallback rewrites.

That is not the whole architecture. It is the first concrete cut that removes current ambiguity while the broader lease
model is implemented.

### 5. Lane-local degradation rules

Rules:

- degraded `forecast_ready` lease blocks only forecast-dependent lanes;
- degraded `options_bootstrap` lease blocks only options-dependent lanes;
- degraded `quant_health` or `execution_trust` lease blocks every lane that requires Jangar authority;
- stale `market_context` lease may demote only market-context-dependent lanes to `shadow` or `observe`.

## Validation gates

Engineer stage must satisfy all of the following:

1. Add lease schema and lease compiler tests.
2. Add parity tests proving scheduler and route paths share the same lease digest and profit-clock decision.
3. Add regression tests for fallback rewrite behavior and for explicit lease binding precedence.
4. Add lane-local deallocation tests for forecast, options, market-context, and quant-health failures.

Deployer stage must satisfy all of the following:

1. Confirm `quant_evidence.source_url` points to the quant-health endpoint, not the control-plane-status endpoint.
2. Confirm `live_submission_gate`, `/readyz`, and `/trading/status` agree on the same lease digest and profit-clock
   result.
3. Confirm degraded forecast or options leases only affect the intended lanes.
4. Confirm rollback restores prior lease bindings without leaving stale leases active.

## Rollout plan

1. Land the fallback rewrite and tests.
2. Add lease tables and publish shadow leases while continuing current runtime behavior.
3. Switch scheduler and routes to lease reads.
4. Add profit-clock enforcement for non-shadow capital.
5. Remove URL-heuristic fallbacks after one stable production cycle.

## Rollback plan

Rollback is a binding reversion, not a data deletion:

- leave lease and clock tables in place;
- restore explicit `TRADING_JANGAR_QUANT_HEALTH_URL` reads if the lease path regresses;
- keep writing shadow leases for forensic comparison until cutover is reattempted.

## Risks and open questions

- The main risk is partial migration where one Torghut path still uses endpoint heuristics.
- Another risk is over-broad lease coupling that turns lane-local blockers back into global blockers.
- The acceptance bar should therefore require digest parity and lane-local deallocation tests before live-capital work.

## Handoff to engineer

- Implement capability-lease and profit-clock persistence.
- Cut scheduler and route paths to shared lease reads.
- Remove URL-heuristic authority after parity is proven.
- Preserve lane-local degradation semantics in every new hypothesis family.

## Handoff to deployer

- Verify the quant-health source URL and lease digest on every rollout that touches Torghut/Jangar authority.
- Treat lease-digest mismatches as hard rollout blockers.
- Do not widen capital stages unless the required profit clocks and leases are both fresh and aligned.
