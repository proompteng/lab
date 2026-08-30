# 48. Jangar Control-Plane Resilience and Torghut Profitability Implementation Contract (2026-03-16)

Status: Approved for implementation (`plan`)
Date: `2026-03-16`
Owner: Victor Chen (Jangar Engineering)
Swarm: `jangar-control-plane`
Mission: `codex/swarm-jangar-control-plane-plan`

## Executive summary

This architecture artifact defines a single implementation contract that removes implicit rollout optimism from both Jangar and Torghut control paths. It is designed to be merged before engineering work starts and used directly by engineer/deployer handoff.

The contract combines:

- Explicit execution-trust gating in Jangar control-plane rollout and readiness.
- Segment-scoped failure classes with deterministic holdoff and evidence-first unfreeze.
- Torghut hypothesis contracts with enforceable replay + guardrail transitions.
- Concrete rollback behavior tied to evidence continuity and confidence budgets.

The decision is to ship architecture in `engineer` phase only after these measurable gates are proven in plan-stage validation.

## Inputs and current objective

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/swarm-jangar-control-plane-plan`
- Swarm: `jangar-control-plane`
- Swarm stage: `plan`

Primary outcomes for this architecture lane:

1. Reduce control-plane failure blast radius for stage failures and stale run windows.
2. Make rollout/release progression deterministic and auditable under uncertainty.
3. Increase Torghut profitability clarity with measurable hypothesis evidence and strict recovery controls.

## Cluster assessment

### Read-only evidence collected

- `kubectl get swarms.swarm.proompteng.ai -n agents jangar-control-plane torghut-quant -o wide` returned both swarms as:
  - `jangar-control-plane   Frozen   lights-out   False`
  - `torghut-quant          Frozen   lights-out   False`

- Detailed status query (snapshot) shows StageStaleness persistence:
  - `jangar-control-plane phase=Frozen freeze=StageStaleness until=2026-03-11T16:36:12.630Z requirements_pending=5 queued_needs=5 stage_stale_discover=290590194ms`
  - `torghut-quant phase=Frozen freeze=StageStaleness until=2026-03-11T16:36:17.456Z requirements_pending=0 queued_needs=0 stage_stale_discover=290472458ms`

- Cluster event window includes repeated hard failures:
  - `BackoffLimitExceeded` for `jangar-swarm-discover-template-step-1-attempt-1`
  - `BackoffLimitExceeded` for `jangar-swarm-plan-template-step-1-attempt-1`
  - `BackoffLimitExceeded` for `jangar-swarm-verify-template-step-1-attempt-1`
  - `BackoffLimitExceeded` for `torghut-swarm-discover-template-step-1-attempt-1`

- Pod-plane observation confirms active controller continuity while template jobs cycle/queue:
  - `agents-controllers-*` and `agents-*` pods running and ready.
  - multiple `jangar-swarm-*` and `torghut-swarm-*` template jobs in `Running` and stale failure states.

- `kubectl api-resources | rg -i 'swarm'` confirms the custom object is `swarms` in `swarm.proompteng.ai/v1alpha1`, so all status evidence is collected from this canonical surface.

### Interpretation

- Stage-level staleness and freeze condition exists for both swarms and is not ephemeral.
- Rollout safety today cannot assume “controller ready” implies safe progression; job-level failures are present independently.
- This supports segment-scoped gate design over global stop-go toggles.

## Source architecture assessment

### High-risk control-plane surface (Jangar)

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/control-plane-watch-reliability.ts`
- `services/jangar/src/server/orchestration-controller.ts`
- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/routes/ready.tsx`

### Current state observed

- Existing architecture already has execution-trust-like fields and stage/freeze signals, but they are not yet uniformly enforced as hard rollout preconditions across all paths.
- Stage states (`discover`, `plan`, `implement`, `verify`) and `StageStaleness` are available and should be authoritative for rollout freeze handling.
- Readiness currently depends on controller-local checks first; explicit trust failures are not guaranteed to block progression by default for every path.
- Test coverage has foundational coverage for status primitives and core controllers, but regression coverage is incomplete for:
  - mixed-segment stale + blocked combinations,
  - lock-step recovery transitions (freeze/clear across segmented stages),
  - irreversible progression prevention when segment class remains systemic/critical.

### High-risk source surface (Torghut)

- `services/torghut/app/trading/hypotheses.py`
- `services/torghut/app/trading/autonomy/policy_contract.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/app/trading/completion.py`
- `services/torghut/app/trading/empirical_jobs.py`
- `services/jangar/src/server/torghut-trading.ts`
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`

### Source gaps for profitability architecture

- There is already strategy hypothesis and gate telemetry, but no single, segment-level promotion contract consumed by both Jangar and Torghut controllers.
- Replay confirmation and lane transition rules are split across modules and are at risk of inconsistent interpretation.
- Hypothesis lifecycle continuity (baseline/challenger + evidence window + regime context) should be elevated to explicit control-plane policy data.

## Database and data-state assessment

### Migrations reviewed

- Jangar control-plane state:
  - `services/jangar/src/server/migrations/20260308_agents_control_plane_component_heartbeats.ts`
  - `services/jangar/src/server/migrations/20260312_torghut_simulation_control_plane.ts`
  - `services/jangar/src/server/migrations/20260312_torghut_simulation_control_plane_v2.ts`
  - `services/jangar/src/server/migrations/20260304_jangar_github_worktree_refresh_state.ts`
- Torghut trading controls and governance:
  - `services/torghut/migrations/versions/0010_execution_provenance_and_governance_trace.py`
  - `services/torghut/migrations/versions/0011_execution_tca_simulator_divergence.py`
  - `services/torghut/migrations/versions/0011_autonomy_lifecycle_and_promotion_audit.py`
  - `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py`
  - `services/torghut/migrations/versions/0022_options_lane_control_plane.py`
  - `services/torghut/migrations/versions/0023_simulation_run_progress.py`
  - `services/torghut/migrations/versions/0024_simulation_runtime_context.py`

### Data quality and freshness constraints

- `StageStaleness` evidence is present in status snapshots and can be used to score trust continuously.
- `requirements.pending` and `queuedNeeds` are currently present for `jangar-control-plane` and are suitable for scoped freeze logic.
- `readiness` snapshots and `conditions` are present and must drive confidence scores.
- Direct DB read access is not available from this runtime context, so this architecture requires immutable evidence references in status and PR artifacts rather than interactive queries for enforcement decisions.

## Alternatives considered

### Option 1: Visibility-only expansion

- Add more status fields and dashboards, but keep existing progression logic unchanged.
- Rejected because it does not constrain blast radius and does not reduce MTTR on repeated stale/systemic failures.

### Option 2: Global hard-stop on any failure signal

- Block rollout on any failure class across every segment.
- Strong safety but too coarse: isolates one-segment failures and can increase incident fatigue.

### Option 3: Segmented trust + evidence-driven rollout envelope with explicit Torghut lane governance (selected)

- Segment failures by `discover/plan/implement/verify` and classify as transient/systemic/critical.
- Tie promotion, canary weight movement, and readiness to explicit trust outputs.
- Require evidence bundles and hypothesis continuity for Torghut lane advancement.
- Reversible, scoped rollback and auditability.

## Decision

Adopt Option 3. It reduces ambiguity, avoids broad lockouts, and creates measurable gates for both reliability and profitability control.

## Proposed architecture contract

### 1) Jangar execution trust contract

Introduce explicit contract fields in control-plane status payloads:

- `executionTrust.decision` in `healthy | degraded | blocked | unknown`
- `executionTrust.failureClass` in `transient | systemic | critical`
- `executionTrust.segmentBlocks[]` with per-segment object:
  - `segment` (`discover`, `plan`, `implement`, `verify`)
  - `decision`
  - `failureClass`
  - `evidenceRefs`
  - `windowMs`
  - `expiresAt`
  - `reasonCode`
- `executionTrust.confidence` in `low | medium | high`

### 2) Deterministic rollout preconditions

Before any canary transition or phase move, enforce:

- `executionTrust.decision === healthy`
- no active segment with `failureClass=critical`
- no segment with unresolved `failureClass=systemic` unless in explicit scoped override and `SegmentRecoveryPlan` present
- positive dependency quorum for watch/reliability and cache/heartbeat signals
- evidence bundle exists for any recently entered freeze state

If blocked:

- hold canary state and do not auto-advance weights
- emit immutable evidence references containing:
  - `swarm` object snapshot
  - related job/status events
  - stage state and failureClass evidence
  - stage freeze history window

### 3) Restart and recovery behavior

- `blocked -> degraded -> healthy` requires two consecutive healthy validations per affected segment.
- transient failures receive bounded decay windows and no immediate full unfreeze.
- systemic failures require explicit operator-clear path with evidence.
- critical failures force hold and scoped incident mode until class downgrade.

### 4) Torghut hypothesis governance contract

Each promotion candidate must carry:

- `hypothesis_id`
- `strategy_id`
- `primary_metric` and `effect_size_min`
- `confidence_threshold`
- `sample_window_policy`
- `evidence_windows`: planning, canary, live-validation
- `risk budgets`:
  - max drawdown delta,
  - reject/block ratio,
  - slippage p95,
  - stale-data lag,
  - regime stability score
- `transition policy`: `observe -> pilot -> scale -> full` with explicit exit constraints and continuity fields.

Policy transitions must pass:

- two consecutive evidence windows with confidence above threshold,
- no unresolved critical risk budget breach,
- no freshness gap in required completion artifacts.

### 5) Unified rollback contract

- Any guardrail breach for two windows triggers automatic downgrade to `pilot/observe` and candidate pause.
- Any segment with `critical` class in Jangar cannot advance and returns to safe hold state.
- Recovery requires explicit evidence + explicit reason code, and both domains must log clear `freeze`, `retry`, `unfreeze` events with references.

## Validation gates

### Engineering gates (pre-merge)

- Add/extend Jangar tests for:
  - segment-level `StageStaleness` -> `executionTrust.decision` transitions,
  - rollout precondition denies for blocked/systemic segments,
  - scoped unfreeze only after two clean windows.
- Add/extend Torghut tests for:
  - hypothesis lane transitions,
  - replay + live evidence continuity,
  - guardrail-triggered demotion.
- API schema snapshots for `/ready`, `control-plane status`, and quant health endpoints to prove deterministic fields and backward-compatible additive shape.

### Deployer gates (handoff to deployer)

- Verify one intentionally failed stage does not clear global rollout locks.
- Confirm that mixed-stage failures keep unaffected segments actionable.
- Confirm two-window evidence requirement before promote to `pilot` and then `scale`.
- Confirm rollback logs are immutable and include `evidenceRefs` for every hold/clear.

## Rollout and rollout/rollback expectations

- **Engineer stage:** implement behind feature gates with schema compatibility; maintain additive outputs first.
- **Canary stage:** exercise mixed blocked + transient/freshness scenarios in synthetic test contexts and block canary progression where expected.
- **Production handoff:** enable enforcement after one full observed cycle with no false lockouts and clean freeze/clear event evidence.
- **Rollback:** isolate scope to the failing segment or hypothesis lane whenever possible; do not degrade unrelated segments.

## Risks and mitigations

- Scope creep in trust logic.
  - Mitigation: keep contract additive and start with explicit schema versioning.
- False positives on transient failures.
  - Mitigation: anti-flap and bounded decay windows by class.
- Evidence bundle size growth.
  - Mitigation: reference-based evidence with retention and truncation policy.

## Handoff contract for engineer and deployer

### Engineer handoff (must be validated against this document)

1. Implement `executionTrust` + segmentBlocks in Jangar status payload and readiness guard.
2. Add rollout precondition checks in orchestration paths using the same contract.
3. Emit immutable evidence refs for every freeze and clear transition.
4. Add Torghut promotion policy evaluation and lane transition tests with continuity evidence checks.

### Deployer handoff

1. Enable enforcement in staged rollout with scoped dry-runs first.
2. Keep `canary` transitions disabled if any segment is blocked or if Torghut lane has unresolved evidence risk.
3. Require two complete evidence windows and guardrail pass for any upgrade past observe.
4. Keep rollout and rollback logs immutable and review before full promotion.

## Merge evidence references

- Previous stage documents used in this lane:
  - `docs/agents/designs/43-jangar-control-plane-execution-trust-safety-net-and-safe-rollout-2026-03-15.md`
  - `docs/agents/designs/44-jangar-control-plane-segmented-failure-domain-and-safe-rollout-contract-2026-03-16.md`
  - `docs/agents/designs/45-jangar-control-plane-trust-and-torghut-profitability-integrated-plan-2026-03-16.md`
  - `docs/agents/designs/47-jangar-control-plane-resilience-and-torghut-profitability-architecture-2026-03-16.md`
  - `docs/agents/designs/torghut-quant-profitability-control-plane-architecture-2026-03-16.md`

## Exit criteria for merge readiness

- execution trust drives rollout progression and readiness in both `ready` and controller paths.
- stage-failure classes are explicit and evidence-backed.
- no canary progression with unresolved blocked/stale segment.
- Torghut promotion is policy-driven, lane-aware, and replay-confirmed.
- Handoff contract below is complete and reviewable.
