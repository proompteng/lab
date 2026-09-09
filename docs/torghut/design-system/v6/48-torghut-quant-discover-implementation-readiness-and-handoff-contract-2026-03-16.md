# 48. Torghut Quant Discover: implementation-readiness and handoff contract (2026-03-16)

## Status

- Date: `2026-03-16`
- Stage: `discover`
- Mission: assess cluster/source/database state and land architecture-ready outputs for safer rollout and profitability improvements
- Branch: `codex/swarm-torghut-quant-discover`
- Base branch: `main`
- Runtime inputs
  - `swarmName: torghut-quant`
  - `swarmStage: discover`
  - `ownerChannel: swarm://owner/trading`

## Executive assessment summary

This discover cycle confirms the v6 control-plane/profitability direction is correct but still requires explicit implementation-ready handoff packaging for execution stability. The cluster is partially healthy with localized failures in options/data components while core control-plane services remain running. The selected design remains:

- Jangar: segment-scoped control authority to bound blast radius during rollout churn and probe noise.
- Torghut: hypothesis lane + budget mesh with explicit demotion behavior to reduce false continuation risk.

## Mission success checks against explicit inputs

1. evidence-backed assessment on cluster rollout/events, source architecture risk, database/data quality (completed).
2. architecture implementation artifacts with options, tradeoffs, scope, validation, rollout and rollback (completed in merged docs and this contract).
3. engineer/deployer handoff acceptance gates for practical rollout (completed).
4. audit artifacts with evidence links and risks (completed in this doc, prior PR references, and run record).

## Cluster assessment (live snapshot)

### Namespaces and health

- `kubectl get namespaces torghut jangar agents` shows `Active` status for all three service namespaces.
- `torghut` is mixed: stable services plus repeated pod-level failures in options and one image pull failure.
- `jangar` is mostly healthy with no broad execution interruption.
- `agents` includes transient failed template pods and active control tasks.

### Torghut pod failures

Current pod sample from `kubectl get pods -n torghut` includes:

- `torghut-options-ta-...` -> `ImagePullBackOff`
- `torghut-options-enricher-...` -> `CrashLoopBackOff`
- `torghut-options-catalog-...` -> `CrashLoopBackOff`
- `torghut-ws-options-...` -> ready status with recent readiness probe failures
- `torghut-00143-deployment-...` -> readiness/liveness probe timeouts

### Torghut/Jangar/Agents events with non-normal states

Representative latest `kubectl get events ... --field-selector type!=Normal` samples:

- `ErrorNoBackup` on `cluster/torghut-db-restore` for `torghut/torghut-db-daily-20260310020000`.
- `ErrorNoBackup` on `cluster/jangar-db-restore` for `jangar/jangar-db-daily-20260309110000`.
- `clickhouseinstallation/torghut-clickhouse` repeated `UpdateCompleted` entries to common ConfigMap.
- `pod/torghut-options-ta...` with `ImagePullBackOff`.
- `pod/torghut-options-enricher...` and `pod/torghut-options-catalog...` with `Back-off` and probe failures.
- `job/torghut-swarm-discover-template...` and `torghut-swarm-verify-template...` in retry/error windows.
- one active `pod/torghut-ws-options...` readiness probe warning (`HTTP 503` previously observed).

### Control-plane status observations

- Existing read path shows key control surfaces and swarms in place, with multiple phases at `Frozen` and mixed readiness behavior.
- There are no namespace-level lockouts; failures appear segment-local and do not produce a full platform outage.

## Source architecture assessment

### Observed strengths

- `services/jangar/src/server/control-plane-status.ts` already has segment-like status dimensions and quorum mapping (`dependency_quorum`, `freshness`, `evidence` related constructs).
- `services/jangar/src/server/torghut-quant-metrics.ts` and runtime helpers already emit operational evidence signals used by rollout trust calculations.
- `services/jangar/src/server/torghut-quant-runtime.ts` has control scheduling and segment update machinery that can consume a stricter scoped contract.
- `services/torghut/app/trading/hypotheses.py` and `services/torghut/app/completion.py` already contain readiness, gate, and evidence surfaces suitable for lane-level budgeting.

### Gaps and coupling risks

- Existing mixed-surface behavior can still map transient watch/boot failures into broad operational posture if contract mapping is not strict per segment/hypothesis.
- Freshness and continuity checks are present but not yet fully reflected as a single bounded, first-class proof envelope used uniformly by all lane transitions.
- Empirical job/family input exists in source but is not yet the canonical gating source for all live-capital decisions.

## Database/data assessment

- Backup continuity issues are clear in control-plane events, and that materially affects confidence windows for continuity-based gating.
- No direct in-cluster SQL verification was executed from this shell due service account/DB constraints already observed in earlier runs.
- Source-level schema migration and persistence surfaces remain present in code paths, but rollout gates still need explicit ledger-first adoption at design-to-implementation boundary.

## Architecture alternatives and tradeoffs

### Option 1: Tune global control without segmenting

- Lower immediate engineering cost.
- Fails to reduce blast radius and preserves common-mode coupling during partial failures.

### Option 2: Manual runbook-only guardrails

- Avoids large architecture changes.
- Slow and variable execution quality; poor for repeated and time-sensitive failures.

### Option 3: Segment-scoped control + hypothesis profitability mesh (selected)

- Preserves existing status infrastructure while constraining impact of noisy failures.
- Supports measurable lane-level continuation and explicit demotion behavior.
- Higher design complexity and stronger observability requirements in first cycles.

## Decision and selected architecture

Option 3 is selected for both domains:

- Jangar control-plane stays segmented by impact domain so one segment failure does not freeze unrelated decision paths.
- Torghut execution uses hypothesis lanes with explicit evidence continuity and budget guardrails.

## Implementation scope that is currently actionable

This cycle keeps code impact in the source-of-truth surfaces already identified in merged PRs and adds a discover handoff contract for deterministic execution.

Design artifacts to treat as merged implementation references:

- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
- `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
- `docs/torghut/design-system/v6/42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/44-jangar-control-plane-resilience-and-safe-rollout-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/45-torghut-quant-profitability-hypothesis-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md`
- `docs/torghut/design-system/v6/47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
- `docs/torghut/design-system/v6/43-torghut-quant-discover-stage-handoff-and-assessment-contract-2026-03-15.md`

## Validation gates (engineer)

Engineers must complete all of the following before production expansion:

1. Segment-guard unit coverage proving one segment block does not hard-fail all lanes.
2. Hypothesis lane matrix tests for `shadow -> canary -> scaled -> degrade -> decommissioned`.
3. Rollback reason-chain and continuity-score tests for at least two consecutive violation windows.
4. API shape snapshots for status and handoff surfaces covering scoped segment + lane states.

## Validation gates (deployer)

1. One probe-failure window where a single segment degrades while another remains active.
2. One scoped rollback drill with persisted evidence IDs and no control-plane freeze escalation.
3. One continuity-gated canary gate where stale evidence blocks capital increase until evidence lineage is restored.

## Rollout plan and rollback expectation

- Rollout order: `shadow` observation -> `observe/warn` -> `dryrun` -> constrained `canary` -> staged scale.
- Rollback conditions:
  - two consecutive critical continuity drops in same segment or lane,
  - repeated false-lockout under healthy non-impacted lane,
  - unresolved `ErrorNoBackup` lineage for critical restore windows.

Rollback action sequence in all cases: lane/segment demotion first, then scoped transition rollback, then evidence replay for postmortem.

## Risks

- Over-fragmentation of control logic until status telemetry is stable.
- False negatives during sparse data windows without adequate fallback budgets.
- Operational overhead from new handoff and evidence-collection obligations.

## Huly artifact notes

- Required channel access path is reachable for cluster/query evidence but blocked for Huly in this environment.
- Public `huly.proompteng.ai` endpoint returns Cloudflare `Error 1010` (`browser_signature_banned`).
- Internal `transactor.huly.svc.cluster.local` accepts unauthenticated probes but hangs on authenticated bearer calls in this environment.
- `upsert mission` and channel-post flows should be retried from a fully connected infra/runtime context.

## Handoff contracts

### Engineer handoff

- Implement scoped segment and lane policies in the existing Jangar/Torghut code paths listed above.
- Keep PR scope constrained to code+design with durable evidence traces and machine-readable failure metadata.

### Deployer handoff

- Execute at most one segment/lane change at a time.
- Keep scoped rollback evidence in run notes with proof IDs, segment, and reason.
- Publish rollback acceptance evidence before any capital scale increase.

## PR and merge evidence (this lane)

- Discovery architecture contracts already merged:
  - `docs(architecture): publish discover control-plane and profitability contracts` -> https://github.com/proompteng/lab/pull/4550
  - merge commit: `fa36e7cac09b5760c67bd4fd7122a509f9235727`
- Earlier merged discover/design PRs on same branch provide the same contract ancestry and are preserved in references above.
