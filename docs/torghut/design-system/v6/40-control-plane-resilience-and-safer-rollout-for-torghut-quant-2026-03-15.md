# 40. Control-Plane Resilience and Safer Rollout for Jangar/Torghut Quant (2026-03-15)

## Status

- Date: `2026-03-15`
- Maturity: `architecture decision + implementation contract`
- Scope:
  - `services/jangar/src/server/{control-plane-status.ts,torghut-quant-metrics.ts,torghut-quant-runtime.ts,torghut-market-context.ts,supporting-primitives-controller.ts}`
  - `services/torghut/app/{hypotheses.py,trading/completion.py,main.py}`
  - `docs/runbooks/torghut-quant-control-plane.md`
  - `argocd/applications/{jangar,torghut}/**`
- Depends on:
  - `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
  - `docs/torghut/design-system/v6/18-trading-readiness-and-rollout-stability-2026-03-04.md`
  - `docs/torghut/design-system/v6/06-production-rollout-operations-and-governance.md`
- Primary objective: reduce false control-plane degrade conditions, isolate watch noise from evidence authority, and make rollout transitions deterministic.

## Evidence baseline (2026-03-15)

### Cluster health / rollout / events

- `kubectl get pods -n torghut` shows service-plane readiness for all required components, but `torghut-00134-deployment` still reports repeated probe latency signals.
- `kubectl -n torghut get events --sort-by=.metadata.creationTimestamp --field-selector type!=Normal` still reports:
  - `Unhealthy` readiness/liveness failures on `torghut-00134-deployment`.
  - repeated `UpdateCompleted` rollouts for ClickHouse.
- `kubectl -n torghut get events ...` also reports:
  - `ErrorNoBackup` on `torghut-db-restore` pointing to missing backup `torghut/torghut-db-daily-20260310020000`.
- `kubectl -n jangar ...` reports analogous restore event:
  - `ErrorNoBackup` on `jangar-db-restore` missing backup `jangar/jangar-db-daily-20260309110000`.
- `kubectl -n torghut get pods`/`-n jangar get pods` are visible with no cross-namespace CrashLoop patterns, but readiness noise exists during probe windows.

### Source architecture surfaces

- `services/jangar/src/server/control-plane-status.ts` already implements dependency quorum and reason codes (`watch_reliability_degraded`).
- `services/jangar/src/server/torghut-quant-metrics.ts` still uses direct query-derived freshness fallbacks and cache-comparison behavior.
- `services/jangar/src/server/torghut-market-context.ts` and `torghut-quant-runtime.ts` remain the authority boundary for market-context and metrics framing, which is strong but tightly coupled to freshness query health.
- `services/torghut/app/trading/hypotheses.py` consumes Jangar dependency decisions for alpha readiness and can block all hypotheses when the quorum degrades globally.
- Existing tests cover many control-plane helper functions, but coverage is sparse for rollback semantics across mixed failure classes (degraded rollout, stale ledger, stale empirical truth, watch jitter).

### Source and database/data health

- `/readyz` on the Torghut LB reports `schema_current=true`, `schema_head_delta_count=0`, and required dependencies healthy.
- `POST /db-check` still reports `schema_current=true` and no immediate schema delta, with known fork warnings already present in migration parents.
- `/trading/status` shows `hypotheses_total=3`, `capital_stage_totals.shadow=3`, `promotion_eligible_total=0` with recurring blocker reasons `feature_rows_missing`, `evidence_continuity_missing`, `signal_lag_exceeded`, and missing empirical jobs.
- `/trading/empirical-jobs` reports all required families as `missing`, confirming evidence starvation at promotion gates.
- `/api/agents/control-plane/status` reports healthy runtime controllers and `dependency_quorum: allow`, while Jangar empirical job contract remains degraded, indicating mixed authority surfaces are now coupled and over-communicative.

## Problem statement

The control-plane is stable enough to be visible, but not resilient enough to be safe under realistic burst failure modes.

Failure classes observed:

1. Watch jitter and restore events are promoted too aggressively into admission semantics, so transient external system drift can delay unrelated hypotheses and rollout actions.
2. Freshness truth is still partially derived in hot paths from queries instead of authoritative writeback events.
3. Probe failures and rollout churn are observed as runtime symptoms without a clear causal graph for whether to hold, degrade, or fail-closed.
4. Rollout safety currently depends on a broad shared readiness state instead of a segmented “who/which capability is degraded” model.

In this state, resilience is not absent; it is noisy.

## Alternatives considered

### Option A: only tune thresholds and add caches

- Lower probe aggressiveness, increase watch tolerances, and expand memory guardrails.
- Benefit: low immediate risk and fast iteration.
- Why rejected: addresses symptoms, leaves common-mode coupling intact.

### Option B: centralize authority in Jangar and bypass hypothesis-level semantics

- Use one control-plane truth plane for all readiness and promotion decisions.
- Benefit: simplified operator UX.
- Why rejected: increases blast radius and removes Torghut's deterministic alpha-specific safety surfaces.

### Option C (chosen): segmented authority with fail-fast lanes and staged rollout mode

- Keep Jangar responsible for producer and dependency telemetry.
- Keep Torghut responsible for hypothesis-specific and profit-specific authority.
- Add explicit segment modes and roll-forward/rollback automata so one degraded segment causes controlled partial impact, not blanket gating.

## Decision

Adopt `Control-Plane Failure-Mode Segmentation v1`:

1. Separate control-plane signals into authoritative buckets:
   - `control_runtime` (controllers, rollout, leader election),
   - `dependency_quorum` (service-level checks),
   - `freshness_authority` (ledger/producer events),
   - `evidence_authority` (empirical jobs),
   - `market_data_context` (materialized market-context bundles).
2. Add a deterministic rollout decision lattice that blocks/soft-fails only the impacted capital lanes.
3. Preserve fail-closed behavior for promotion, but reduce false global failure by avoiding global coupling for transitory watch jitter.
4. Define explicit rollout mode transitions with evidence gates and bounded last-known-good TTLs.

## Architecture

### 1. Four-segment authority contract

Each segment emits:

- status (`healthy/degraded/blocked`),
- source (`rollout`, `heartbeat`, `ledger`, `authority`),
- `observed_at`,
- `as_of`,
- `confidence` (`high/medium/low`),
- and segment-local reasons.

Segment behavior:

- `control_runtime`: derived from controller/rollout health and must gate only when no deterministic recovery path exists.
- `dependency_quorum`: uses Jangar existing quorum but treats watch stream jitter as advisory after two full sample windows without state loss.
- `freshness_authority`: consumes producer-authored freshness rows first, with legacy comparison fallback only in shadow.
- `evidence_authority`: maps only empirical truth families with non-stale jobs as gating evidence.
- `market_data_context`: requires domain materialization for any strategy that demands the domain.

### 2. Jangar rollout safety envelope

`services/jangar/src/server/control-plane-status.ts` gains:

- segment-local decision output,
- segment-level reason taxonomy,
- `degradation_scope` tags (`global`, `capital-family`, `hypothesis-scoped`, `single-capability`).

`watch_reliability_degraded` ceases to be a blanket reason; it becomes a scoped advisory unless:

- watch continuity drops below one rolling window threshold,
- no healthy snapshots exist for relevant segments,
- or segment confidence degrades below threshold during two consecutive windows.

### 3. Torghut segment-aware admission bridge

`services/torghut/app/trading/hypotheses.py` moves from monolithic gate interpretation to:

- per-hypothesis dependency binding,
- segment compatibility checks (`market_context_bundle`, `evidence_jobs`, `signal_continuity`, `feature_batch_rows`),
- explicit "why not promoted" reason chain per segment.

### 4. Probe and rollout resilience behavior

For each rollout:

1. `ready` and `liveness` probe failures in one pod transition to `soft_warning` after one sample and to `degraded` after windowed confirmation.
2. `degraded` does not force immediate kill-switch; it activates `segment_guard` to freeze capital transitions only.
3. Rollout changes pause only for the impacted segment if evidence suggests local recovery.

## Implementation contract

### Wave A (readiness and telemetry segmentation)

Engineer scope:

- add segment schema to Jangar control-plane status payload,
- add `dependency_quorum` and `freshness_authority` reasons to separate channels,
- preserve existing legacy output behind `controlPlaneSegmentedReadiness`.

Acceptance gates:

- one segment failure does not convert to global `degraded` if other segments remain `healthy` and confidence is medium/high,
- rollout-related pod restarts are represented as `control_runtime` changes with bounded TTL,
- `/api/agents/control-plane/status` includes segment telemetry and `degradation_scope`.

### Wave B (soft-fail and scoped blocker semantics)

Engineer scope:

- add scoped blocker translation in `hypotheses.py`,
- keep fail-closed for promotion while enabling hypothesis-level continuation,
- include segment-compatible fallback when evidence freshness exists but market-context bundle is stale for non-dependent hypotheses.

Acceptance gates:

- one hypothesis can remain in `shadow` while another is `blocked` for segment-specific reasons,
- promotion blockers include reason prefixes (`seg.market_data`, `seg.evidence`, `seg.freshness`, `seg.quorum`, `seg.runtime`),
- `/trading/status` explicitly exposes per-hypothesis segment states.

### Wave C (rollout and rollback orchestration)

Engineer + deployer scope:

- add rollout mode controls (`dryrun`, `observe`, `gate`, `full`),
- add automatic mode fallback:
  - `observe -> gate` when segment mismatch persists >1 market hour,
  - `gate -> dryrun` on two consecutive rollout sessions with stale empirical authority.
- document rollback playbook in runbook and SRE runbook section.

Acceptance gates:

- no cross-segment blast by default,
- no capital transition while any active capital segment is `blocked`,
- deployment rollback becomes segment-aware and explainable in logs.

## Validation plan

### Automated

- unit tests for segment translation in `control-plane-status.ts` and `hypotheses.py`,
- tests for watch jitter vs genuine outage classification,
- tests for per-hypothesis scope under mixed segment failure,
- tests for rollout mode transitions and idempotent fallback.

### Live validation

- `kubectl -n torghut get events --field-selector type!=Normal` should show recovery-classification trends without global control-plane status spam.
- `/api/agents/control-plane/status` must include `segment` and `degradation_scope`.
- `/trading/status` should retain meaningful reasons without converting all hypotheses to global blockers under partial segment faults.
- `/trading/health` and `/readyz` should stay operationally stable under one segment fault, and fail-closed only when the authoritative segment is blocked.

### Measurable hypotheses for this architecture change

- H1: under synthetic watch jitter, hypothesis-scoped blockers increase from 0 to at least one per impacted lane instead of all-three global block.
- H2: rollout failure-to-recovery median time decreases by at least 35% once segment transitions replace global fail states.
- H3: repeated probe restarts without dependency loss should no longer suppress readiness for more than 2 segments.

## Rollout plan

1. ship Wave A with legacy outputs retained as shadows.
2. one full US session in observe mode with synthetic fault replay on watch events.
3. ship Wave B and hold for one full session.
4. ship Wave C only after runbook drill and evidence of segment telemetry parity across both namespaces.
5. require engineer/deployer signoff before defaulting to scope-aware rollout controls.

## Rollback plan

Rollback is immediate and non-destructive:

- disable `controlPlaneSegmentedReadiness`,
- disable scoped-blocker translation in Torghut hyp readiness,
- revert to canonical legacy readiness payload in both `status` and `trading/status`,
- pause rollout mode transitions until postmortem closes.

Hard rollback triggers:

- any segment mismatch persists for 2 market sessions,
- evidence contradiction between segment telemetry and raw controller events grows above 5% in one session,
- or an operator receives two or more false-negative execution transitions.

## Risks

- Segment taxonomy may over-fragment decision logic and hide correlated outages.
- Feature-flag rollout risk if `control_runtime` and `dependency_quorum` disagree in ambiguous windows.
- More complex incident operations if operators are not trained to use the new `degradation_scope` fields.
- If fallback telemetry is stale, scoped mode can look healthy while real capacity is unavailable.

## Engineer handoff

Engineer stage is complete when:

1. Jangar control-plane status payload exposes per-segment status and reasons.
2. Torghut hypothesis readiness includes segment-specific blockers and partial-blocking semantics.
3. Existing regression tests for legacy global behavior remain green in shadow comparison mode.
4. New tests cover watch jitter, stale evidence, and segment scope transitions.

## Deployer handoff

Deployer stage is complete when:

1. `ErrorNoBackup` and probe jitter events no longer create immediate global rollout freeze.
2. `/api/agents/control-plane/status` and `/trading/status` are segment-aligned for one full session.
3. Rollout mode transitions are practiced against a staging replay and one live canary observation window.
4. rollback steps are documented and tested in runbook.

## Final recommendation

Safety gains for this platform come from making failures smaller and more precise, not from pretending everything is healthy.
