# 54. Torghut Capital-Lease Receipts and Profit-Falsification Ledger (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Related mission: `codex/swarm-torghut-quant-discover`
Companion doc:

- `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`

Extends:

- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
- `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`

## Executive summary

The profitability gap is no longer just "we need stricter blocking." The runtime now needs a better mechanism for
allocating scarce live capital to hypotheses that still have fresh edge and for revoking that capital the moment the
evidence turns false.

Read-only evidence captured on `2026-03-20` shows the current contradiction:

- `curl -sS -D - 'http://torghut.torghut.svc.cluster.local/readyz'`
  - returned `503`
  - `dependencies.database.schema_current = false`
  - `schema_current_heads = ["0025_widen_lean_shadow_parity_status"]`
  - `expected_heads = ["0024_simulation_runtime_context"]`
  - `live_submission_gate.allowed = false`
  - `live_submission_gate.reason = "alpha_readiness_not_promotion_eligible"`
- `curl -fsS 'http://torghut.torghut.svc.cluster.local/trading/health'`
  - `dependencies.live_submission_gate.ok = true`
  - `dependencies.live_submission_gate.capital_stage = "0.10x canary"`
- `curl -fsS 'http://torghut.torghut.svc.cluster.local/trading/status'`
  - `live_submission_gate.reason = "alpha_readiness_not_promotion_eligible"`
  - `live_submission_gate.blocked_reasons = ["alpha_readiness_not_promotion_eligible", "live_promotion_disabled"]`
  - `live_submission_gate.dependency_quorum_decision = "allow"`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?window=15m'`
  - `status = "degraded"`
  - `latestMetricsCount = 72`
  - `maxStageLagSeconds = 39678`
- Torghut Postgres live reads:
  - `alembic_version = 0025_widen_lean_shadow_parity_status`
  - `strategy_hypotheses.count = 0`
  - `strategy_hypothesis_metric_windows.count = 0`
  - `vnext_empirical_job_runs.count = 12`
  - `vnext_empirical_job_runs.latest = 2026-03-19 10:31:27.46274+00`
  - `torghut_options_contract_catalog.latest = 2026-03-11 01:06:33.304365+00`
- ClickHouse live reads:
  - all `system.replicas.is_readonly = 0`
  - `ta_signals rows_10m = 0`
  - `ta_microbars rows_10m = 0`
- `kubectl -n torghut logs pod/torghut-options-catalog-... --tail=120`
  - `FATAL: password authentication failed for user "torghut_app"`
- `kubectl -n torghut logs pod/torghut-options-enricher-... --tail=120`
  - `FATAL: password authentication failed for user "torghut_app"`

Interpretation:

- readiness, trading health, and trading status are not consuming one authority artifact;
- empirical-job history exists, but active hypothesis and metric-window state is empty;
- options evidence is stale and its bootstrap path still fails before policy can consume typed state;
- profitable capital progression is therefore under-specified exactly when the system needs hypothesis-level evidence.

The selected architecture is to add **Capital-Lease Receipts** and a **Profit-Falsification Ledger**:

- each hypothesis sleeve receives a short-lived lease only if rollout authority, empirical evidence, market freshness,
  execution quality, and lane-specific segments agree;
- any falsification event revokes the lease immediately;
- `/readyz`, `/trading/status`, scheduler submission, and promotion logic all consume the same lease id;
- options failures become lane-scoped falsification inputs rather than import-time process crashes.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- ownerChannel: `swarm://owner/trading`

This architecture artifact succeeds when:

1. cluster, source, and database/data evidence are captured with exact read-only proof;
2. at least two viable directions are compared and one is selected with explicit tradeoffs;
3. live-capital authority is derived from one lease id rather than several loosely related gate payloads;
4. profitable hypotheses and guardrails become measurable and revocable at the sleeve level.

## Assessment snapshot

### Cluster and runtime evidence

Torghut currently has three different capital stories at the same time:

- `/trading/health` still implies canary-capital progress;
- `/readyz` rejects readiness because database contract and alpha-readiness checks disagree with the live head;
- `/trading/status` blocks promotion, but still consumes `dependency_quorum = allow` from Jangar.

That means process health, rollout health, and profit authority are still coupled loosely enough to drift apart.

### Source architecture and high-risk modules

The source tree matches the live contradiction:

- `services/torghut/app/trading/submission_council.py`
  - `build_live_submission_gate_payload(...)` emits a coarse gate payload, not a durable receipt;
  - scheduler, status, and readiness can therefore reason over similar but not identical snapshots;
  - local gate assembly still trusts `dependency_quorum_decision` without a shared Jangar receipt id.
- `services/torghut/app/options_lane/catalog_service.py`
  - constructs `OptionsRepository(settings.sqlalchemy_dsn)` and immediately seeds DB defaults at import time.
- `services/torghut/app/options_lane/enricher_service.py`
  - repeats the same import-time side effect.
- `services/torghut/app/forecast_service.py`
  - cleanly separates `healthz` and `readyz`, which is good, but it shows the broader pattern: process health and
    economic readiness are different questions and should not share ad hoc truth surfaces.

Current regression gaps:

- no test proving `/readyz`, `/trading/status`, scheduler submission, and promotion logic expose the same lease id;
- no test proving empty active hypothesis/metric-window state forces `observe` even when some empirical jobs exist;
- no test proving stale options evidence becomes a lane-scoped falsification event rather than a process crash;
- no test proving stale quant or market-context inputs revoke existing capital above `observe`.

### Database and data-quality evidence

The current database state is good enough to build a lease ledger and poor enough to justify it:

- schema head is ahead of the expected readiness contract, which explains current `/readyz` disagreement;
- active hypothesis state and metric windows are empty, so profitable capital cannot be justified from recent
  hypothesis performance;
- empirical jobs exist, but they are not sufficient alone to authorize capital;
- options catalog state is materially stale;
- ClickHouse replicas are writable, but recent market rows are empty.

The profitable move is therefore not "global freeze forever." It is "allocate capital only through revocable, recent,
hypothesis-scoped leases."

## Problem statement

Torghut still lacks four profitability-critical primitives:

1. one authoritative lease id for the current capital decision;
2. one falsification path that revokes capital as soon as required evidence turns stale or contradictory;
3. one measurable mapping from active hypothesis evidence to allowed capital stage and budget;
4. one lane-scoped way to absorb options failures without globally erasing non-options opportunity.

Without those primitives, the system can be conservative in the wrong places and optimistic in the wrong places at the
same time.

## Alternatives considered

### Option A: keep extending the coarse live-submission gate

Summary:

- add more booleans and blocking reasons to the existing gate payload;
- keep status, readiness, and scheduler logic loosely synchronized.

Pros:

- smallest local code delta;
- straightforward to ship.

Cons:

- keeps authority fragmented;
- does not create a reusable capital artifact for deployers, postmortems, or cross-plane consumers;
- still leaves profitability allocation too coarse for hypothesis-level capital management.

### Option B: force all capital back to `observe` whenever any evidence degrades

Summary:

- one stale or degraded dependency globally freezes non-observe capital.

Pros:

- easy to reason about;
- safer than the current contradictions.

Cons:

- destroys profitable option value because isolated lane failures would freeze unrelated sleeves;
- prevents controlled capital experimentation when only one lane or one hypothesis is degraded;
- turns a targeted falsification problem into a blanket shutdown.

### Option C: capital-lease receipts plus a profit-falsification ledger

Summary:

- Jangar rollout authority feeds into a lease builder;
- each hypothesis sleeve receives a short-lived lease if its evidence is fresh enough and profitable enough;
- falsification events immediately revoke or downgrade that lease.

Pros:

- unifies all capital decisions around one durable artifact;
- improves profitability by letting Torghut keep capital where the recent edge is still proven;
- preserves lane-scoped firebreaks, especially for options dependencies;
- gives deployers one lease id and one falsification stream to audit.

Cons:

- broader persistence and scheduler wiring work;
- requires careful threshold tuning so leases are neither noisy nor permissive;
- needs new parity and falsification tests across several surfaces.

## Decision

Adopt **Option C**.

The right next move is not just to block more often. It is to allocate and revoke capital from one lease contract that
measures hypothesis-level evidence and turns contradiction into immediate falsification.

## Proposed architecture

### 1. Capital-lease receipts

Add durable lease tables in Torghut:

- `capital_lease_receipts`
  - key: `{hypothesis_id, sleeve_id, lease_epoch_id}`
  - fields:
    - `lease_id`
    - `decision` in `{observe, canary, live, quarantine}`
    - `max_capital_fraction`
    - `expected_edge_bps`
    - `max_expected_drawdown_bps`
    - `jangar_admission_receipt_id`
    - `empirical_bundle_ref`
    - `market_context_ref`
    - `quant_health_ref`
    - `execution_quality_ref`
    - `options_segment_ref`
    - `published_at`
    - `expires_at`
- `capital_lease_segments`
  - one row per required segment:
    - `jangar_rollout_authority`
    - `market_context`
    - `quant_latest_store`
    - `hypothesis_metric_window`
    - `empirical_jobs`
    - `execution_quality`
    - `options_auth`
    - `options_bootstrap`
    - `schema_contract`
    - `clickhouse_freshness`

Required invariant:

- `/readyz`
- `/trading/status`
- scheduler submission
- promotion / deallocation logic

must all expose the same active `lease_id` for a given hypothesis sleeve.

### 2. Profit-falsification ledger

Add `profit_falsification_events` with typed revocation causes:

- `jangar_receipt_expired`
- `market_context_stale`
- `quant_latest_store_stale`
- `metric_window_missing`
- `empirical_bundle_expired`
- `execution_slippage_exceeded`
- `options_auth_invalid`
- `options_bootstrap_unhealthy`
- `schema_contract_mismatch`
- `clickhouse_freshness_missing`

Any active falsification event for a required segment revokes the lease immediately or downgrades it to `observe`.

### 3. Hypothesis-local lease policy

A sleeve may receive capital above `observe` only when:

- Jangar admission receipt decision = `allow`;
- at least one active hypothesis metric window exists for the sleeve;
- empirical evidence for the sleeve is recent enough for the configured holding horizon;
- quant health and market context are within freshness policy;
- execution-quality evidence stays within slippage and fallback budgets;
- required lane-specific segments, including options segments where applicable, are healthy.

This is the profitability improvement:

- capital flows to hypotheses with recent measured edge;
- stale or unsupported hypotheses remain at `observe`;
- non-options sleeves do not lose capital because options bootstrap is unhealthy.

### 4. Options bootstrap as evidence, not process side effect

Replace import-time DB seeding with a bootstrap receipt path:

- options catalog and enricher start in a typed bootstrap state machine;
- they publish `options_auth` and `options_bootstrap` lease segments;
- a bad DB secret becomes a falsification event instead of a hard process crash;
- options-dependent sleeves are blocked or quarantined, while unrelated sleeves keep their own leases.

### 5. Implementation scope

Engineer stage must implement:

- one pure lease builder consumed by readiness, status, scheduler, and promotion code;
- the lease and falsification tables;
- typed conversion from Jangar receipt ids to lease segments;
- options bootstrap state publication;
- status payload updates that expose `lease_id`, falsification reasons, and expiry to deployers.

## Validation and acceptance gates

Engineer acceptance gates:

- regression proving empty `strategy_hypothesis_metric_windows` yields `decision = observe`;
- regression proving `/readyz`, `/trading/status`, and scheduler submission expose the same `lease_id`;
- regression proving a stale Jangar receipt or quant-health segment revokes an active lease;
- regression proving options DB auth failure yields `options_auth_invalid` falsification instead of boot crash;
- regression proving non-options sleeves remain eligible when only options segments are degraded.

Deployer acceptance gates:

- do not trust any capital decision that does not expose an active `lease_id`;
- do not promote or widen capital when a falsification event is active for a required segment;
- confirm lease expiry, segment health, and Jangar receipt parity before each rollout checkpoint.

## Rollout plan

1. Land the lease and falsification tables with a shadow-mode builder.
2. Publish `lease_id` and segment details in status payloads without enforcing them.
3. Convert options services to bootstrap-state publication.
4. Switch scheduler submission and `/trading/status` to the lease builder.
5. Switch `/readyz` and promotion logic to the same lease builder.
6. Enable automatic lease revocation on falsification events.

## Rollback plan

- If lease tuning is noisy, keep publishing leases but disable enforcement while preserving falsification history.
- If options bootstrap conversion misbehaves, keep the lease builder but temporarily mark options segments as
  informational for non-options sleeves only.
- Do not delete lease or falsification history during rollback; those rows are needed for diagnosis and replay.

## Risks

- Lease thresholds that are too strict could suppress useful canary capital.
- Lease thresholds that are too loose would recreate the current optimism problem under a new name.
- Options bootstrap conversion needs careful coordination with the existing GitOps fixes for secret alignment.

## Handoff to engineer

Treat the lease builder as the single source of truth. The architecture is not complete if status, readiness, or
scheduler paths still compute capital authority from different snapshots.

Exact acceptance gates:

- one active `lease_id` per hypothesis sleeve;
- required segments stored and queryable;
- falsification events revoke leases deterministically.

## Handoff to deployer

Use the lease id and falsification stream as the live-capital authority.

Deployment must stop when:

- required surfaces disagree on `lease_id`;
- any required segment is stale, unknown, or falsified;
- the referenced Jangar admission receipt is expired or challenged.
