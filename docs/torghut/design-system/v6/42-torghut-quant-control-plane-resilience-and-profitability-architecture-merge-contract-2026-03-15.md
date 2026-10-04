# 42. Torghut Quant Control-Plane Resilience + Profitability Architecture Merge Contract for Discover Stage (2026-03-15)

## Status

- Date: `2026-03-15`
- Maturity: `architecture decision + implementation preface`
- Stage: `discover`
- Scope: cluster/state assessment, source risk mapping, database/data confidence baseline, and production contract for engineer/deployer implementation.
- Mission objective: increase control-plane reliability while enabling measurable profitability improvements in Torghut quant under constrained evidence conditions.

## Objective and success metrics (runtime inputs)

- swarmName: `torghut-quant`
- swarmStage: `discover`
- ownerChannel conversation URI: `swarm://owner/trading`
- Mandatory success criteria:
  1. evidence-backed assessment of cluster health/rollout/events, source architecture, and database/data quality
  2. at least one implementable architecture decision contract merge
  3. explicit engineer handoff and deployer handoff acceptance with measurable gates
  4. evidence and risks documented for tradeoff-aware execution

## Cluster assessment

- Pod plane currently has all critical torghut and jangar services Running in the namespaces.
- `kubectl -n torghut get pods -o wide` output includes:
  - `torghut-00134-deployment...` running `2/2` with `0` restarts
  - `torghut-db-1`, `torghut-ta`, `torghut-ws`, clickhouse and guardrail exporter all Running
  - `jangar-84ccfb97c-rmzg7` running `2/2`
- Non-normal events show ongoing control-plane stress:
  - torghut: repeated `Unhealthy` readiness/liveness probe timeout for `torghut-00134-deployment`
  - torghut: repeated `ErrorNoBackup` for `cluster/torghut-db-restore` backup `torghut/torghut-db-daily-20260310020000`
  - jangar: `ErrorNoBackup` for `cluster/jangar-db-restore` backup `jangar/jangar-db-daily-20260309110000`
  - multiple clickhouse `UpdateCompleted` config-map updates within a short interval
- Permissions posture is constrained and read-only for critical control APIs:
  - cannot list `deployments`, `secrets`, execute pods, or inspect argocd from this operator token
  - this limits direct rollback surgery and direct db `cnpg psql` validation in this run
- Runtime logs confirm the same control/data coupling failure:
  - repeated `/torghut-quant` `ta_signals` freshness failures with `MEMORY_LIMIT_EXCEEDED` in ClickHouse aggregations
  - unresolved branch refs in `github-review-ingest` for active PR IDs
- Control surface implication:
  - startup and rollout noise is currently being elevated to platform-level authority even where data service and trading runtime are mostly stable

## Source assessment

- High-risk modules observed during read-only source scan:
  - `services/jangar/src/server/control-plane-status.ts`
    - existing dependency quorum still carries stream-level degradation directly into decision paths
  - `services/jangar/src/server/torghut-quant-metrics.ts`
    - freshness still derived from heavy ClickHouse query paths in some branches
  - `services/torghut/app/trading/hypotheses.py`
    - readiness is still counter-dominant and not yet proof-lane-isolated by hypothesis
  - `services/torghut/app/completion.py`
    - transition/capital stage calculations do not yet enforce multi-horizon proof budgets per-hypothesis
- Test gap evidence:
  - current hypothesis tests exercise many counter transitions but do not yet assert:
    - cross-hypothesis isolation under mixed proof quality
    - demotion behavior on post-cost evidence regressions
    - behavior with stale watch surface + healthy execution surface
    - proof-window TTL interactions across lane transitions
- Source inference:
  - safety architecture is present but still monolithic in failure coupling
  - profitability governance remains a global/shared-counter control surface

## Database and data quality assessment

- `/readyz` and `/db-check` are health-facing signals of process readiness in prior outputs and currently not showing local migration divergence blockers.
- ClickHouse query path is available in service path but fails under memory constraints for freshness scans:
  - ta freshness aggregation errors show `MEMORY_LIMIT_EXCEEDED` with repeated fallback logs
  - this confirms freshness cannot remain a hot-path proof mechanism
- Cluster-level security posture prevents direct DB query validation this cycle (no exec into DB pods via service account).
- Data inference for architecture:
  - source truth for freshness and proof must come from producer-authored, bounded observations
  - empirical proof and evidence lineage should be persisted as first-class inputs for readiness/capital transitions

## Alternatives and tradeoffs

### Option A: tune current coupled behavior

- reduce query cadence, raise limits, adjust probe thresholds
- lower operational friction quickly
- does not reduce blast radius because global coupling remains
- does not provide per-hypothesis profitability traceability

### Option B: disable watch/watch-health coupling globally

- remove `watch_reliability` as blocker and keep current architecture
- avoids blanket lockout
- increases chance of hidden blind spots and silent freshness drift

### Option C: segment control-plane authority + lane profitability proof contracts (chosen)

- split control-plane truth into independent surfaces with scoped degradation:
  - rollout surface for startup/readiness noise
  - freshness surface for component observations with producer TTL
  - authority surface for capital readiness decisions
- run profitability as per-hypothesis proof-market lanes with explicit risk envelopes
- preserve fail-closed behavior where true evidence expiry is unresolved, but avoid global bleed across unrelated hypotheses

## Decision: adopt Control-Plane Resilience Spine + Profitability Proof Lanes v1

This design is selected because it directly addresses both objectives from current evidence:

- control-plane noise is causing false global lockout
- profitability has no lane-level, budget-aware path from proof windows to capital allocation

### 1) Control-plane resilience spine

- create producer-authored observations for each surface:
  - `watch_ingest`
  - `knative_startup`
  - `ta_signal_freshness`
  - `market_context_bundle`
  - `empirical_job_scheduler`
- create per-surface rollups with explicit TTL and reason-chain metadata
- move decision input from single `watch_reliability_degraded` to scoped surface decisions:
  - `blocked` only when surface staleness budget + missing last-good evidence align
  - `degraded` when transient; maintain warning and evidence references
  - `unknown` only when producer data absent beyond grace window

### 2) Profitability proof lanes

- define persistent proof windows and proof readiness rows in Torghut:
  - `window_id`, `hypothesis_id`, `window_start/end`, `feature_coverage`, `continuity`, `market_context_state`, `empirical_refs`, `signal_quality`
- gate capital transitions on proof readiness + post-cost profitability + drawdown and route quality budgets
- each hypothesis transitions independently; one hypothesis may be in canary while another remains shadow
- stale proof input invalidates only the affected lane, not every hypothesis

### 3) rollout safety and evidence coupling

- rollout gates become staged and explicit:
  - preview: dual-write observation; no hard lockout
  - shadow: compare legacy vs spine outcomes; emit mismatch telemetry
  - enforced: enforce scoped locks only when surface TTL and evidence budgets truly require

## Implementation scope (actionable)

- Jangar (readiness truth producers and rollup consumers):
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/torghut-quant-status.ts`
  - `services/jangar/src/server/torghut-quant-metrics.ts`
  - observation persistence path(s) under Jangar server layer
- Torghut (capital/proof authority):
  - `services/torghut/app/trading/hypotheses.py`
  - `services/torghut/app/completion.py`
  - `services/torghut/app/main.py` status surfaces
- Operator documentation:
  - `docs/torghut/design-system/v6/*`
  - `docs/runbooks/torghut-quant-control-plane.md`
  - relevant migration and deployment manifests under `argocd/applications/{jangar,torghut}/**`

## Validation gates (engineering)

- at least one hypothesis must have independent proof-derived `ready`/`blocked` state without forcing all hypotheses to the same state
- rollout `shadow` mode must show non-empty scoped reasons and zero unknown-state bleed for healthy surfaces
- `watch_ingest` degradation must no longer directly induce hard lockout unless freshness budget and `last_good_until` are both invalid
- ClickHouse hot-path heavy freshness scans are replaced by bounded surface reads for control-plane decisions
- proof-window persistence and budget calculations are covered by regression tests

## Validation gates (deployer)

- one complete US session in `shadow` mode must produce telemetry showing legacy vs spine decision mismatch count and no unresolved critical lockout
- one production session in `enforced` mode must keep:
  - no unexpected full-system rollback lockouts
  - no repeated hard mismatch on unchanged evidence
- at least one hypothesis transitions from shadow to canary via proof readiness and stays there under positive route quality
- all rollout and proof-plane toggles are documented and reversible within documented maintenance window

## Rollout and rollback

### Rollout

- Week 1 (Discover → Plan): finalize schema, add observation producers, add dual-write in Jangar
- Week 2: ship scoped decision comparison with runbook updates and alert labels
- Week 3: enable shadow rollup decisions for Torghut readiness surface
- Week 4: enable enforced rollout gates with guardrails and staged enablement in staging-like confidence windows

### Rollback

- disable enforced gate toggles
- restore prior dependency behavior and retain observation rows for forensics
- keep per-surface evidence trails in place for post-incident replay
- rollback trigger examples:
  - two consecutive enforced-vs-legacy hard mismatch sessions
  - rising false-block rate on healthy deployment windows
  - proof-lane transitions without supporting sample quality

## Risks

- schema and migration complexity in both Jangar and Torghut if TTL and reason enums diverge
- false confidence in producer observations if evidence references are not strictly validated
- operational complexity from dual-mode operation during shadow/enforced transitions
- cross-team interpretation drift unless handoff gates are explicit per stage

## Handoff contracts

- Engineer handoff acceptance:
  - implement observation schema, rollups, and scoped surface decisions
  - implement proof-window persistence and per-hypothesis budget-aware transition checks
  - add regression tests for mixed-failure surfaces and lane independence
  - expose `proof_window_id`, `lane_state`, and scoped reasons in runtime status surfaces
- Deployer handoff acceptance:
  - runbook checklists for scoped rollout events and proof-lane failure modes are updated
  - one full shadow session + one enforced session executed with documented gate outcomes
  - rollback path confirmed and tested
  - hard rollout decisions remain reversible within agreed window

## Merged document references (this architecture set)

- `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safe-rollout-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/41-profitability-hypothesis-and-guardrail-contract-2026-03-15.md`

## Why this contract is the required merge artifact

The run demonstrates that cluster, source, and data surfaces currently have enough evidence to lock the architecture direction.
The architecture decision is explicit, auditable, and staged with measurable thresholds so implementation can proceed without
repeated “design-only” ambiguity.
