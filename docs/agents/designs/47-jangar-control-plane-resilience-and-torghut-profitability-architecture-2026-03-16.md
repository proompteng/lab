# 47. Jangar Control-Plane Resilience + Torghut Profitability Architecture (2026-03-16)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-16`
Owner: Victor Chen (Jangar Engineering Architecture)
Related mission: `codex/swarm-jangar-control-plane-discover`
Swarm: `jangar-control-plane`

## Executive summary

This document sets the merged architecture direction for the current discover cycle:

- Jangar must move from optimistic status/rollout coupling to explicit failure-class-based control, with deterministic holdoff and recovery behavior under frozen/stale stage conditions.
- Torghut must move from ad-hoc profitability interpretation to explicit hypothesis-driven promotion with enforceable guardrails and auditable evidence.
- Both lanes require evidence-first handoffs so deployment decisions can be reproduced from status snapshots, migration state, and completion artifacts.

## Assessment snapshot (2026-03-16)

### Cluster health / rollout / events

- `kubectl get swarms.swarm.proompteng.ai -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.status.phase} { .status.requirements.pending} {.status.freeze.reason} {"\n"}{end}'`
  - `agents/jangar-control-plane Frozen 5 StageStaleness`
  - `agents/torghut-quant Frozen 0 StageStaleness`
- `kubectl get pods -n agents` currently shows:
  - active running controllers in agents namespace
  - `jangar-swarm-*` and `torghut-swarm-*` template jobs in mixed states, including `Error`/`Backoff`
  - job templates with recent retries and failed executions
- `kubectl get events -A --field-selector type=Warning --sort-by='.lastTimestamp' | tail -n 120` includes:
  - repeated `BackoffLimitExceeded`/`ErrorNoBackup`
  - template configmap `MountVolume` failures
  - `torghut` readiness probe failures and backoff restart loops
  - `Feature` namespace backup restore lag artifacts
- Outcome: freeze + staged execution instability is live and requires explicit, deterministic holdoff before canary progression.

### Source architecture, high-risk modules, and test gaps

- High-risk runtime control surface identified:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/control-plane-watch-reliability.ts`
  - `services/jangar/src/server/orchestration-controller.ts`
  - `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/routes/ready.tsx` has readiness gate wiring but trust enforcement is currently feature-gated and not guaranteed across all rollout triggers.
- Current status logic already has stage/freeze primitives and `ExecutionTrust` shape, but cluster behavior evidence shows stage classes are not yet the single source of rollout truth in all paths.
- Test surface has unit coverage for schema and status primitives but does not yet include:
  - mixed-stage stale+degraded transitions through rollout preconditions
  - rollback/clearance transition evidence assertions
  - guardrail contract enforcement for quant hypothesis promotions

### Database / source-data assessment

- Jangar control-plane migrations include `.../migrations/20260308_agents_control_plane_component_heartbeats.ts`, `20260220_torghut_market_context_run_lifecycle.ts`, and related migration chain updates that define control-plane state tables.
- Torghut has a full migration chain and guardrail-oriented job/test scaffolding (`0001..0024`, `test_check_migration_graph.py`, `test_strategy_hypothesis_governance_migration.py`).
- Live DB reads from this identity are not possible (no `pods/exec` and no direct CNPG read path from `agents`), so contract quality is evaluated via migration/test signals and completion/trace interfaces.
- `services/torghut/app/trading/completion.py` and `services/jangar/src/server/torghut-trading.ts` already emit completion and rejection telemetry suitable for hypothesis evidence; this becomes the enforcement point rather than additional bespoke event stores.

## Problem framing

1) **Jangar reliability gap**: mixed-stage failures and stale run windows can be present while rollout/policy checks remain permissive.
2) **Rollout ambiguity gap**: stage failures, readiness, and canary transitions are not coupled through one deterministic trust envelope.
3) **Torghut promotion gap**: profitability outcomes exist, but candidate promotion evidence is not uniformly encoded as a contract with risk budgets and regime-aware governance.
4) **Evidence portability gap**: current handoff does not force immutable evidence bundles on freeze/rollback events by default.

## Candidate architecture options

### Option A — Keep status changes isolated to observability
- Keep control-plane visibility but avoid enforcement changes.
- Pros: minimal risk and implementation cost.
- Cons: does not reduce failure blast radius and leaves no hard recovery guarantee.

### Option B — Add single hard stop on `StageStaleness`
- Block all rollout when any stage is stale.
- Pros: fast safety improvement.
- Cons: over-broad freezes and weak support for transient infra faults.

### Option C — Segmented trust envelope + hypothesis promotion contract (recommended)
- Unify reliability and profitability control into two linked envelopes:
  - Stage-level failure-class envelope for Jangar rollback and canary holdoff.
  - Quant policy envelope for Torghut with explicit evidence, confidence, and guardrails.
- Pros: bounded blast radius, deterministic recovery, measurable rollout and trading behavior.
- Cons: higher implementation discipline and contract maintenance.

## Decision

Adopt **Option C** for discover architecture completion. This is the only option that converts current ambiguous failure states into an explicit, testable and auditable control-plane contract.

## Proposed architecture

### 1) Jangar: segmented failure-domain contract

Define an explicit **Execution Trust Contract** consumed by readiness and rollout paths:

- `executionTrust.decision`: `healthy | degraded | blocked | unknown`
- `executionTrust.failureClass`: `transient | systemic | critical`
- `executionTrust.blockingWindows`: ordered list of `{surface, surfaceId, severity, startAt, ttlMs, reasonCode, evidenceRefs}`
- Per-swarm and per-stage records include:
  - `phase`, `ready`, `freeze`, `ageMs`, `staleAfterMs`, `pendingRequirements`, `classedFailures`, `recentFailureRate`, `confidence`

Decision matrix:

- `Transient`: one-off infra or probe misses. Action: bounded retry with short decay.
- `Systemic`: repeated stale or backoff for stage(s). Action: hold canary transitions, require evidence bundle and operator-visible hold state.
- `Critical`: multi-surface unresolved block with confidence low. Action: enforce hard rollout freeze and explicit recovery plan.

### 2) Jangar rollout contract and safe progression

Before any canary weight step:

1. `executionTrust.decision === healthy`
2. all active stages within failure-class budgets
3. `watch_reliability` stable for configured window
4. dependency quorum for critical services (`agentrun`, watch streams, control surfaces) healthy/confirmed

If any check fails:

- block progression (`hold` or `block`)
- attach immutable evidenceRefs: namespace snapshot + swarm snapshot + warning events + stage history window
- preserve rollout state; no implicit auto-advance

### 3) Jangar recovery and rollback contract

- `blocked -> degraded -> healthy` requires two consecutive healthy validation samples per impacted stage.
- evidence bundle is written for freeze entry and clear, including pending-requirement deltas.
- confidence dips below low > 15m auto-emits advisory override condition and requires explicit human review token.

### 4) Torghut: profitability hypothesis architecture

Introduce an enforceable `HypothesisPolicy` consumed by quant promotion controls:

- hypothesis identity and causal statement
- primary metric (`Sharpe`, `return`, `vol-adjusted pnl`, `hit_rate`)
- expected effect and minimum effect size
- regime plan (`open`, `pre_market`, `volatile`, `off_hours`)
- guardrail budgets (`drawdown delta`, `reject ratio`, `slippage p95`, `stale-data lag`)
- confidence threshold and evidence window schedule
- degrade/remediate mode (`observe`, `pilot`, `full`) with explicit transitions

Promotion requires:

- simulation smoke window + live canary window evidence
- explicit `hypothesis_id` and completion artifact references
- guardrail pass in both windows
- confidence and cross-regime stability checks

### 5) Torghut rollback policy

- Any guardrail breach for two consecutive windows forces automatic demotion to `observe` and candidate pause.
- `stopped` promotion path remains traceable with immutable candidate artifacts retained for replay analysis.

## Validation gates (explicit)

### Engineering gates

- `services/jangar/src/server/control-plane-status.test.ts`: deterministic mapping from `StageStaleness` and failure-class transitions to execution-trust outputs.
- `services/jangar/src/routes/__tests__/ready.test.ts`: readiness returns non-200 on `executionTrust.decision != healthy`.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`: snapshot/assertions for blocking windows and per-stage class outputs.
- `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts` (or equivalent): rollout precondition blocks on unresolved trust conditions.
- `services/jangar/src/server/__tests__/orchestration-controller.test.ts`: freeze holdoff and staged-clearance behaviors.
- Torghut quant route/unit tests: hypothesis policy validation, replay confirmation, and guardrail enforcement.
- Migration/contract sanity checks for any new policy payloads before rollout.

### Deployer gates

- No canary progression while `executionTrust.decision != healthy`.
- One staged failure window in `agents` produces immutable evidence bundle and no silent unfreeze.
- Torghut `pilot -> full` requires two consecutive evidence windows with guardrail pass and no confidence erosion.

## Rollout and rollback expectations

- **Engineer stage**: implement envelope and policy code paths in staged feature switches; keep wire-compatible schema additions in status/route responses.
- **Canary stage**: run single swarm job replay to verify blocked transitions block rollout and recover only with evidence bundle.
- **Production handoff**: enable enforcement after two consecutive successful canary cycles.
- **Rollback**: auto-restrict to observe/pilot when class remains `critical`, or when two consecutive guardrail breaches occur in Torghut.

## Risks and tradeoffs

- Overly strict classes can lengthen recovery windows during transient infra incidents.
- Evidence payload size and schema evolution may increase status payload verbosity.
- Regime-aware profitability metrics can create contradictory signals if telemetry lags.

Mitigations:

- short anti-flap windows and explicit decay,
- additive contracts with versioned evidence refs,
- holdoff budgets tied to confidence plus explicit owner acknowledgement for overrides.

## Success criteria

- `executionTrust.decision` governs rollout progression in all canary transitions.
- no canary progression during `StageStaleness` windows without evidence-based clearance.
- every freeze/clear action emits immutable evidenceRefs and owner-readable reasons.
- every Torghut promotion requires hypothesis policy + two-window guardrail pass.
- PR merge and deployer runbooks consume a single source of truth artifact bundle from this contract.

## Handoff contract between engineer and deployer

### Engineer stage handoff

1. Implement status schema extension and rollout predicate changes.
2. Wire execution-trust/torghut policy evaluations behind explicit tests.
3. Emit evidence bundles for each block/clear transition.
4. Attach PR evidence references (docs + migrations + test IDs).

### Deployer stage handoff

1. Configure staged rollout: `observe -> pilot -> full` for Torghut candidates.
2. Enable canary holdoff controls from Jangar execution trust contract.
3. Confirm backup/restore and probe recovery deltas are represented in evidence bundles.
4. Keep rollback logs immutable and verify two successful evidence windows before full release.

