# 43. Torghut Quant Discover Stage: Assessment, Decision, and Handoff Contract (2026-03-15)

## Status

- Date: `2026-03-15`
- Stage: `discover`
- Mission objective: assess current cluster/source/database state and complete merged architecture outputs for resilient control-plane operation and measurable profitability progress in `torghut-quant`.

## Objective and success metrics (runtime inputs)

- swarmName: `torghut-quant`
- swarmStage: `discover`
- ownerChannel conversation URI: `swarm://owner/trading`
- explicit success metrics:
  1. evidence-backed assessment for cluster rollout/events, source risk, database/data quality
  2. explicit architecture decision and implementation contract
  3. engineer/deployer handoff acceptance gates that are testable
  4. runbook-oriented risks, rollout and rollback expectations

## Cluster assessment

- live read path was attempted from this session with restricted permissions.
  - `kubectl config current-context` reported no context.
  - in-cluster token path did not contain service-account credentials (`/var/run/secrets/.../token`, `/var/run/secrets/.../ca.crt`, `/var/run/secrets/.../namespace`), so no pod/argocd/`cnpg psql` access was available.
- because of that, cluster evidence for this run is read from existing artifacted snapshots (as-of March 15):
  - recurring control-plane churn and readiness/liveness noise in torghut/jangar service-plane surfaces
  - `ErrorNoBackup` restore events for `torghut-db` and `jangar-db`
  - repeated probe failures under market activity windows, with no global crash-loop pattern
- implication: cluster signals indicate failure-mode coupling risk is still present, and run-time safety requires scoped control-plane semantics to avoid blast radius during temporary stream noise.

## Source assessment

- high-risk coupling and evidence-path surfaces observed:
  - `services/jangar/src/server/control-plane-status.ts`: global dependency quorum still allows stream-level degraded states to influence broad gating.
  - `services/jangar/src/server/torghut-quant-metrics.ts`: freshness and lag fallback still include direct query paths as gating inputs in some paths.
  - `services/torghut/app/trading/hypotheses.py`: readiness outcomes remain shared across hypothesis cohorts when decision surfaces are degraded.
  - `services/torghut/app/completion.py`: transition and capital-stage checks are not yet per-hypothesis profitability-lane independent.
- test coverage gap confirmed for this discovery pass:
  - mixed-failure surface scenarios where watch jitter + healthy execution should permit partial continuation
  - lane-local proof continuity with per-hypothesis demotion under post-cost performance regression
  - control-plane freshness evidence staleness vs. execution continuity crossover behavior

## Database/data assessment

- source-level DB migration status is generally healthy in surfaced checks:
  - no blocking schema delta in latest observed `/readyz`/`/db-check` snapshots
  - known migration lineage tolerances are already documented in production rollout artifacts
- freshness evidence remains a structural bottleneck:
  - ClickHouse ta freshness fallbacks still appear under memory pressure (`MEMORY_LIMIT_EXCEEDED` in fallback traces), confirming heavy query scans are not a stable authority source for control-plane decisions.
- conclusion: data truthing should move to bounded producer-authored observation surfaces with explicit TTL and quality references.

## Alternatives considered

1. Tune existing coupled controls only
   - lowers noise but preserves blast radius and does not improve per-hypothesis profitability isolation.
2. Remove watch-related gating globally
   - avoids broad lockout from stream noise but hides true evidence loss.
3. Segmented control-plane authority + profitability proof lanes (selected)
   - isolate surfaces (watch, startup, freshness, market context, empirical jobs), keep per-hypothesis profitability evidence, and preserve fail-closed behavior where evidence truly expires.

## Decision

Adopt the merged discover architecture direction already captured in:

- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safe-rollout-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/41-profitability-hypothesis-and-guardrail-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`

This decision is now implemented as an architecture lane, not as draft notes.

## Engineer handoff scope (actionable)

- Jangar control-plane status surfaces must emit scoped segment outputs with confidence windows and reason-chain metadata.
- Torghut readiness/profitability should move from shared counters to hypothesis-scoped proof surfaces with explicit lane state and demotion semantics.
- schema and control-plane observation writes must preserve forensic continuity and deterministic mismatch telemetry during shadow/rollback transitions.

## Deployer handoff scope (operational)

- enforce scoped rollout transitions through documented modes (`observe`, `shadow`, `enforced`) with bounded rollback windows
- validate at least one shadow and one enforced pass before increasing capital exposure for live canary.
- maintain reversible rollback with preserved reason and evidence references for postmortem replay.

## Validation and rollout gates

### Engineer gates

- one hypothesis canary transition without forcing unrelated hypotheses to the same state
- scoped segment `degraded` should not hard-block all hypotheses unless surface quorum and freshness budgets both fail
- proof windows, hypothesis readiness, and capital transitions are persistently testable and regression-covered

### Deployer gates

- no global lockout from isolated segment faults
- rollout mode and rollback controls (`shadow -> enforced`) remain reversible
- canary transition stability is maintained across one full market session

## Rollout plan

1. Discovery validation: finalize this merged-contract implementation and confirm source-of-truth mapping.
2. Shadow phase: dual-read from legacy and spine-style controls with mismatch telemetry.
3. Enforced pilot: enable scoped hard gates only when mismatch profile is stable and evidence budgets are aligned.
4. Full rollout: expand to full hypothesis-capacity operations with explicit circuit-breaker thresholds.

## Rollback plan

- disable scoped enforced gates and revert to previous global behavior if:
  - two consecutive sessions show hard mismatch on non-degrading evidence
  - scoped blocker bleed increases above threshold
  - reason telemetry indicates false-negative lockout in otherwise healthy surfaces
- keep observation records for deterministic replay; execute GitOps rollback for control-plane controls only (no destructive DB operations).

## Risks

- partitioned control semantics can increase operational interpretation complexity
- incomplete Huly/cluster visibility can delay incident confirmation in this runtime
- mis-sized TTL/capability windows can cause either false `unknown` states or late lockouts

## Huly artifact IDs

- chat context access: blocked in this run due Cloudflare edge signature challenge against public Huly endpoint; no thread/channel IDs could be resolved from this runtime.
- planned follow-up artifact IDs should be attached when channel access is restored.

## PR and merge evidence

- architecture merge contract PR: https://github.com/proompteng/lab/pull/4496
- control-plane/profitability design merge PR: https://github.com/proompteng/lab/pull/4492
- merged head commit for 42-merge contract: `b9f45908aed96119866a1fe3144058ab85486ba0`
- merged head commit for 40/41 family: `8b9e6056bd1c05e6fae55824482dd7ee07a969e3`
