# 52. Jangar Segment Authority Graph and Promotion Certificate Fail-safe (2026-03-19)

Status: Ready for merge (plan architecture lane)
Date: `2026-03-19`
Owner: Gideon Park (Torghut Traders Architecture)
Related mission: `codex/swarm-torghut-quant-plan`
Swarm impact: `jangar-control-plane`, `torghut-quant`
Companion doc:

- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`

Supersedes/extends:

- `49-jangar-control-plane-authority-ledger-and-expiry-watchdog-2026-03-19.md`
- `50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `docs/torghut/design-system/v6/49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`

## Executive summary

The March 19 live state shows one repeated systems failure: the platform observes the right symptoms, but no single
authority surface owns the final rollout and capital decision.

- `jangar-control-plane` and `torghut-quant` remain `Frozen` on `StageStaleness` even though `freeze.until` expired on
  `2026-03-11` and new jobs are still being created in `agents`.
- `GET /api/agents/control-plane/status?namespace=agents` still reports healthy database and rollout state, but
  `execution_trust` and `swarms` are absent and `agentrun_ingestion.status` is `unknown`.
- `GET /trading/status` and `GET /trading/health` for Torghut still return `live_submission_gate.allowed = true` and
  `capital_stage = "0.10x canary"` while `promotion_eligible_total = 0`.
- Jangar quant health is degraded with `latestMetricsCount = 0` and open lag alerts, while Torghut options services are
  failing on DB auth, image pull, and desired-symbol bootstrap.

The architectural change in this document is to replace fragmented truth with two durable artifacts owned by Jangar:

1. a **Segment Authority Graph** that publishes the live state of every stage, dependency, credential epoch, and
   collaboration segment required for rollout and trading decisions;
2. a **Promotion Certificate** that is the only object allowed to authorize non-observe capital for Torghut hypotheses.

Jangar becomes the authoritative decision spine. Torghut becomes a certificate consumer rather than a second live-gate
authority.

## Assessment snapshot

### Cluster health, rollout, and events

Read-only evidence captured on `2026-03-19`:

- `kubectl -n agents get swarm jangar-control-plane torghut-quant -o json`
  - both swarms report `phase = Frozen`, `ready = False`, `reason = StageStaleness`
  - stage timestamps are still anchored on `2026-03-08`
  - `freeze.until` is still `2026-03-11`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
  - `database.status = healthy`
  - `rollout_health.status = healthy`
  - `watch_reliability.status = healthy`
  - `agentrun_ingestion.status = unknown`
  - `execution_trust = null`
  - `swarms = null`
- `kubectl -n torghut get pods -o wide`
  - `torghut-options-catalog` and `torghut-options-enricher` are in `CrashLoopBackOff`
  - `torghut-options-ta` is in `ImagePullBackOff`
  - `torghut-ws-options` is repeatedly failing readiness
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 50`
  - confirms `Readiness probe failed`, `Liveness probe failed`, `BackOff`, and `ImagePullBackOff` churn in the
    options lane while the main Torghut revision keeps becoming ready

### Source architecture and test gaps

The codebase already has the ingredients for safer control, but the final truth is still fragmented:

- `services/jangar/src/server/control-plane-status.ts`
  - keeps `DEFAULT_EXECUTION_TRUST_ENABLED = false`
  - only adds `execution_trust` and `swarms` when the feature flag is enabled
- `services/jangar/src/routes/ready.tsx`
  - still treats missing execution trust as effectively ready
- `services/jangar/src/server/control-plane-watch-reliability.ts`
  - stores watch evidence in process-local memory rather than durable authority records
- `services/torghut/app/main.py`
  - `_build_live_submission_gate_payload` is the API-side gate function
  - it is not backed by a persisted certificate or shared by every live path
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still has its own `_live_submission_gate` path, so the scheduler can drift from the status API
- `services/torghut/app/trading/hypotheses.py` and `services/torghut/app/trading/autonomy/lane.py`
  - still flatten Jangar dependency state into one global quorum decision, so segment-local firebreaks cannot yet
    demote only the hypotheses that declare those segments
- `services/torghut/app/lean_runner.py`
  - still defaults upstream empirical-authority eligibility to `true` when authority metadata is absent, which is a
    fail-open seam for any future promotion-certificate consumer
- `services/torghut/app/options_lane/repository.py`
  - options-lane startup immediately seeds rate-limit state in Postgres, so a credential problem becomes a hard boot
    crash before the system emits a structured segment reason

Coverage gaps that matter right now:

- no regression proving expired freeze state cannot outlive its TTL while `/ready` stays green
- no durable authority history for watch, rollout, or credential epoch transitions
- no parity test proving scheduler and status consume the same Torghut capital decision
- no regression proving segment-local dependency failures demote only the hypotheses that declare those segments
- no regression proving `emptyLatestStoreAlarm` or `latestMetricsCount = 0` forces capital back to `observe`
- no regression proving missing upstream empirical-authority metadata keeps promotion eligibility fail-closed
- no explicit options-lane readiness taxonomy for `options_db_auth_invalid`, `options_image_unavailable`, or
  `options_bootstrap_stale`

### Database, schema, and data freshness

The underlying data stores are not uniformly broken. The problem is that freshness and credential failures are not
first-class control inputs.

- Torghut `/db-check`
  - `schema_current = true`
  - expected and current head are both `0024_simulation_runtime_context`
  - schema lineage still carries parent-fork warnings
- Jangar control-plane status
  - `migration_consistency.applied_count = 24`
  - `migration_consistency.unapplied_count = 0`
- Jangar quant health
  - `status = degraded`
  - `latestMetricsUpdatedAt = null`
  - `latestMetricsCount = 0`
  - `emptyLatestStoreAlarm = true`
- Jangar quant alerts
  - open critical `metrics_pipeline_lag_seconds` alerts exist across `1m` through `20d`
  - an open negative `sharpe_annualized` warning remains on the active paper account
- Jangar market-context health for `AAPL`
  - `overallState = degraded`
  - `technicals` and `regime` are `ok`
  - `fundamentals` and `news` are stale
- Torghut options-lane logs
  - `password authentication failed for user "torghut_app"` in catalog and enricher
  - `torghut-ws-options` cannot fetch desired symbols and returns `503` on `/readyz`

The architecture therefore needs to distinguish:

- schema health from data freshness,
- pod liveness from credential validity,
- segment-local outages from portfolio-wide capital truth,
- operator status views from final promotion authority.

## Problem framing

1. Jangar still treats control-plane truth as optional. When `execution_trust` is disabled, the exact surface that
   should block rollout can disappear from status and readiness.
2. Segment failures are visible but not authoritative. The system can see options DB auth errors, empty quant stores,
   and stale market context without translating them into one durable decision object.
3. Torghut still has multiple live-capital authorities. Status APIs, scheduler logic, and hypothesis summaries can each
   tell a different story.
4. Credential rotation and artifact readiness are not explicit failure domains. A pod can be `Running` while its DB
   auth or image provenance is already invalid for rollout or capital safety.
5. Profitability evidence is observed but not bound to a single deployable certificate with expiry, provenance, and
   rollback rules.

## Architecture alternatives

### Option A: enable current execution trust and tighten live gate in place

Pros:

- smallest implementation delta
- reuses current status and Torghut gate structures

Cons:

- still leaves no durable segment or credential history
- still allows scheduler/API drift unless every path is manually rewired
- still provides no portable artifact for deployer rollout and rollback

### Option B: add a global hard stop whenever quant or options is degraded

Pros:

- easy to reason about operationally
- immediately safer than the current contradictory state

Cons:

- too coarse for profitability
- options-lane failures would freeze unrelated hypotheses and research windows
- creates safety by destroying blast-radius isolation

### Option C: add a Segment Authority Graph plus Promotion Certificates with credential-epoch fail-safe

Pros:

- makes every blocking input durable, queryable, and replayable
- unifies rollout safety and capital safety under the same authority model
- allows segment-scoped firebreaks instead of global freezes
- gives engineer and deployer lanes one testable contract to build against

Cons:

- larger cross-system scope
- requires new persistence, status surfaces, and Torghut gate consolidation

## Decision

Adopt **Option C**.

The March 19 evidence is not a monitoring gap. It is an authority gap. The system needs one durable graph for what is
healthy and one durable certificate for what may carry capital.

## Proposed architecture

### 1. Segment Authority Graph

Jangar owns a persisted authority graph with one row per live segment lease:

- `control_plane.segment_leases`
  - key: `{swarm, segment, source_id}`
  - fields: `segment_kind`, `status`, `severity`, `observed_at`, `expires_at`, `reason_codes`, `evidence_bundle_id`,
    `credential_epoch`, `producer_build`, `producer_revision`
- `control_plane.segment_events`
  - immutable append-only log of `block`, `delay`, `recover`, `expired`, `epoch_mismatch`, and `bootstrap_failed`
    transitions
- `control_plane.evidence_bundles`
  - immutable references to the exact status payloads, alerts, job digests, pod failures, and health snapshots used for
    each transition

Required segment groups for this mission:

- `stage.discover`
- `stage.plan`
- `stage.implement`
- `stage.verify`
- `control-plane.agentrun-ingestion`
- `market-context`
- `ta-core`
- `options-data.catalog`
- `options-data.enricher`
- `options-data.ws`
- `options-data.ta`
- `execution`
- `empirical`
- `llm-review`
- `collaboration.huly`

The graph is not just status decoration. It is the source of truth for readiness, rollout gating, and promotion
certificate issuance.

### 2. Mandatory control-plane contract

Remove the notion of optional truth from the Jangar surface:

- `/api/agents/control-plane/status`
  - always includes `authority_graph`, `expired_segments`, `required_segments`, and `promotion_certificate_summary`
- `/ready`
  - fails when required stage leases expire
  - fails when a required control-plane segment is `block`
  - fails when freeze expiry has not been reconciled into a fresh authority decision
- `Swarm.status.phase`
  - becomes a projection of graph state rather than an independent authority input

This turns `Frozen after freeze expiry` from a lingering symptom into an explicit graph state:

- `freeze_active`
- `freeze_expired_unreconciled`
- `shadow_catchup_running`
- `recovering`
- `healthy`

### 3. Credential epoch fail-safe

Credential validity becomes its own authority dimension.

Add `control_plane.credential_epochs` with:

- `segment`
- `credential_ref`
- `epoch_hash`
- `issued_at`
- `producer_ack_at`
- `acknowledged_revision`

Rules:

- any DB auth failure, secret mismatch, or image bootstrap failure emits a `segment_event`
- a segment may not be `healthy` unless the running producer has acknowledged the latest credential epoch
- image and bootstrap state are treated the same way as DB auth for options-data segments
- rollout cannot clear on pod `Running` alone; it needs an acknowledged epoch and fresh lease

This specifically closes the March 19 options-lane hole where pods exist, but the segment is not actually promotable.

### 4. Promotion Certificates

Promotion is authorized by a certificate minted by Jangar, not by any single Torghut process-local gate.

Add `control_plane.promotion_certificates` keyed by:

- `hypothesis_id`
- `candidate_id`
- `strategy_id`
- `account`
- `window`
- `capital_state`

Required fields:

- `certificate_id`
- `data_quorum_state`
- `segment_summary`
- `quant_health_snapshot_ref`
- `quant_frame_snapshot_ref`
- `market_context_snapshot_ref`
- `alpha_readiness_snapshot_ref`
- `reason_codes`
- `issued_at`
- `expires_at`
- `issuer_build`
- `issuer_revision`

Valid `capital_state` values:

- `observe`
- `canary`
- `live`
- `scale`
- `quarantine`

Torghut scheduler and status API may only grant non-observe capital when a current certificate exists for that exact
tuple.

### 5. Segment firebreak rules

Each Torghut hypothesis manifest maps to explicit dependency segments. Example:

- baseline equity momentum
  - `ta-core`
  - `market-context`
  - `execution`
- options-sensitive intraday extension
  - `ta-core`
  - `market-context`
  - `options-data.catalog`
  - `options-data.enricher`
  - `options-data.ws`
  - `options-data.ta`
  - `execution`

Rules:

- options-data failures demote only options-dependent hypotheses
- stale or `down` required market-context domains block promotion to `live` or `scale` for hypotheses that require
  them
- `ta-core` or `execution` failure can demote portfolio-wide because those are shared market/trade safety rails
- `collaboration.huly` blocks autonomous plan/implement closure, but not paper evidence collection

This preserves profitability isolation without pretending local failures are harmless.

### 6. Measurable trading hypotheses and guardrails

This architecture is only useful if it supports measurable profit improvement.

Define three mission-level hypotheses:

1. Options-sensitive hypotheses outperform baseline post-cost expectancy only when all `options-data.*` segments are
   fresh and acknowledged.
   - gate: two consecutive complete evidence windows
   - guardrails: no open critical lag alert, no empty latest store, no negative expectancy window
2. Non-options hypotheses remain promotable during options-lane outages with no increase in reject rate or forced
   rollback.
   - gate: unaffected segment set remains healthy
   - guardrail: no more than one false demotion per trading day
3. Segment failures demote capital within one lease window and never leave stale capital live after certificate expiry.
   - target demotion latency: `< 60s`
   - target stale-certificate budget: `0`

Baseline certificate requirements before `observe -> canary`:

- `promotion_eligible_total > 0`
- fresh quant frame for the evaluated window
- `latestMetricsCount > 0`
- no `emptyLatestStoreAlarm`
- no blocking segment in the mapped dependency set
- no certificate older than its expiry window

### 7. Version-skew control

Every certificate and segment lease records:

- producer build version
- producer revision/image digest
- source endpoint revision used in the evidence bundle

If the scheduler build, status build, and certificate issuer build do not agree, the system falls back to `observe`
unless a deployer explicitly overrides in shadow mode.

This addresses the current March 19 contradiction where the live payload allows canary capital despite zero promotion
eligibility and degraded quant data.

## Validation gates

Engineer gates:

- make `authority_graph` unconditional in `services/jangar/src/server/control-plane-status.ts`
- update `services/jangar/src/routes/ready.tsx` so expired freeze or blocked required segments fail readiness
- add durable storage and regression coverage for segment leases, events, evidence bundles, and credential epochs
- make Torghut scheduler and status share one certificate reader
- add tests proving empty quant latest-store state and open lag alerts force `observe`
- add options-lane readiness reasons for DB auth, image, and bootstrap failure modes
- add tests proving unaffected hypotheses stay eligible when only `options-data.*` is degraded

Deployer gates:

- verify `authority_graph` appears in live Jangar status without a feature flag
- verify expired stage leases surface as `freeze_expired_unreconciled`
- induce a safe options DB auth mismatch in shadow mode and prove only options-dependent hypotheses demote
- verify no `canary`, `live`, or `scale` action executes without a fresh promotion certificate
- verify build/revision mismatch downgrades capital to `observe`

## Rollout

1. Ship graph persistence and status surfacing in shadow mode.
2. Start dual-writing segment leases and certificate candidates while legacy gates still run.
3. Compare legacy live-gate outputs against certificate outputs for one full trading week.
4. Switch Torghut scheduler to certificate enforcement once mismatch rate is zero for the required window.
5. Remove the legacy permissive gate paths and stale `execution_trust` feature-flag behavior.

## Rollback

- keep graph writes enabled, but switch certificates back to advisory-only mode
- force all hypotheses to `observe` if certificate reads fail or graph freshness regresses
- preserve evidence bundles and segment events during rollback so deployers can replay the failed decision chain
- do not revert to pod-status-only rollout decisions

## Risks and open questions

- credential epoch derivation must avoid leaking secret material while remaining deterministic across restarts
- graph persistence adds write amplification to Jangar and needs bounded retention
- strict segment mapping will require manifest hygiene for every live hypothesis family
- Huly collaboration is currently an operational dependency with an unstable transactor path; it should be modeled as a
  segment for autonomous mission closure, but not for paper evidence collection or trading replay

## Handoff contract

Engineer and deployer stages should treat this document as the current cross-system source of truth for March 19 plan
work. The implementation is accepted only when:

1. Jangar status, readiness, and swarm progression all read from the same graph state.
2. Torghut scheduler and status API cannot disagree on capital state.
3. Segment-local failures demote only the mapped hypotheses.
4. Promotion requires a fresh certificate with explicit evidence references.
5. Rollout and rollback can be replayed from durable evidence rather than logs and pod state.
