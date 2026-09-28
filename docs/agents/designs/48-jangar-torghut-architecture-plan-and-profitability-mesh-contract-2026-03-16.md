# 48. Jangar-Torghut Plan Architecture: Resilient Rollout Mesh + Hypothesis-Governed Profitability (2026-03-16)

## Objective

This document defines the next architecture stage for `codex/swarm-torghut-quant-plan` on base `main`.

- mission: assess current cluster/source/database state,
- design outcome: mergeable architecture artifacts that materially improve control-plane reliability and Torghut profitability behavior,
- scope: control-plane segmentation, rollout safety behavior, hypothesis-driven trading decisions, and explicit deployer/engineer handoff gates.

## Assessment evidence used for design decisions

### Cluster health, rollout, and events

- Swarm health snapshot (`kubectl get swarms.swarm.proompteng.ai -A`):
  - `agents/jangar-control-plane` is `Frozen` with `StageStaleness` and pending requirements `5`.
  - `agents/torghut-quant` is `Frozen` with `StageStaleness` and pending requirements `0`.
- Torghut namespace run state (`kubectl get pods -n torghut -o wide`) includes live failures in options lane:
  - `torghut-options-ta` is `ImagePullBackOff`.
  - `torghut-options-catalog` is `CrashLoopBackOff`.
  - `torghut-options-enricher` is `CrashLoopBackOff`.
  - `torghut-ws-options` is ready but restart-heavy with `HTTP 503` readiness events.
- Rollout and platform events (`kubectl get events -A --field-selector type!=Normal --sort-by=.lastTimestamp`):
  - repeated `BackoffLimitExceeded` for template stages (`jangar-swarm-*` and `torghut-swarm-*` jobs),
  - `ErrorNoBackup` for both `jangar-db-restore` and `torghut-db-restore`,
  - repeated readiness/liveness failures on options and deployment pods,
  - `Feature` namespace `ReconcileFailed` noise around Ceph object user cleanup.
- Control-plane read scope: frozen and stage-stale signals are present even when core components continue; this implies shared gating must not treat all failures as global emergencies.

### Source architecture risk and test gaps

Observed risk clusters from in-tree source review:

- Jangar status and rollout surfaces exist and are rich (`services/jangar/src/server/control-plane-status.ts`, `services/jangar/src/routes/ready.tsx`, `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/torghut-quant-runtime.ts`, `services/jangar/src/server/torghut-quant-metrics.ts`).
- Current readiness/risk path already has confidence and dependency concepts but does not yet enforce a strict segment-to-rollout coupling across all transitions.
- Torghut source has hypothesis and readiness surfaces (`services/torghut/app/trading/hypotheses.py`, `services/torghut/app/main.py`, `services/torghut/app/completion.py`, `services/torghut/app/trading/empirical_jobs.py`) but not a single lane-level profitability budget contract consumed by all control-plane transitions.
- Testing coverage contains unit tests for status transforms and hypothesis helpers but lacks matrix-level tests for mixed segment degradations, segment recovery sequencing, and candidate demotion under repeated guardrail breaches.

### Database/data freshness and continuity

- Torghut migration chain is present up to `0024_simulation_runtime_context` in `services/torghut/migrations/versions`; this supports hypothesis, empirical, and completion entities.
- Control-plane events show missing backup lineage objects (`ErrorNoBackup`), reducing confidence in continuity windows for live scale decisions.
- RBAC prevented pod exec, so runtime DB query verification is evidence-limited; design must therefore prioritize schema-defined continuity fields and event-driven evidence bundles rather than ad hoc manual SQL snapshots.

## Problem framing

1. A global freeze model is too coarse for mixed failures. Current stage-level staleness can stall unrelated rollout transitions.
2. Segment-local outages (for example options ingestion) are currently overrepresented in rollout truth paths, inflating blast radius.
3. Profitability promotion can still remain process-driven even when per-hypothesis evidence decays; this creates risk of silent drift under regime shifts.
4. Existing handoff evidence is distributed, with no single source-of-truth artifact for engineer and deployer obligations during mixed segment or mixed-hypothesis incidents.

## Architectural alternatives and tradeoffs

### Option A: keep current status primitives and retune thresholds

Pros:

- minimal code risk,
- fast to execute.

Cons:

- no meaningful blast-radius reduction,
- no deterministic segment recovery semantics,
- guardrail interpretation remains implicit.

### Option B: enforce global manual freeze controls and manual deployer checklists

Pros:

- strong human visibility,
- no extra schema changes.

Cons:

- inconsistent reaction time,
- difficult to verify in CI,
- increases operator dependence during degraded-but-recovering windows.

### Option C: segment-scoped rollout contracts + hypothesis profitability mesh (selected)

Pros:

- isolates degradation to impact surface,
- defines measurable hypothesis-to-lane behavior,
- enables deterministic scoped rollback and recovery,
- creates machine-readable acceptance gates for both engineer and deployer.

Cons:

- larger implementation surface than tune-only options,
- requires explicit evidence discipline in status and completion payloads,
- needs staged rollout with rollback validation.

## Decision

Select Option C.

The cluster shows repeated segment-local instability and control-plane staleness; therefore resilience can only be improved with explicit scoped behavior. On Torghut side, profitability gains require measurable, hypothesis-specific evidence with automatic demotion logic.

## Contract architecture to implement in plan lane

### 1. Jangar segmented rollout trust contract

Introduce explicit segment state with deterministic predicates:

- Segment identifier: `discover | plan | verify | implement | options | inference | data-plane`.
- Segment status: `healthy | warn | blocked | hold | recoverable-fail`.
- Segment trust metadata:
  - `segment_freshness_ms` from control-plane watch health,
  - `failure_class` (`transient`, `systemic`, `critical`),
  - `failure_rate_5m`, `failure_rate_15m`,
  - `evidence_refs` (immutable list of event and snapshot IDs),
  - `cooldown_until` and `recovery_ready_at`.
- Global readiness is a computed join over segments with strict policy:
  - if any segment in `blocked` or `hold`, rollout for that segment is paused,
  - unrelated segments may continue at `warn` or `healthy`.

### 2. Segment transition engine

Rollout transition rule set:

- `attempt_transition(segment, next_weight)` requires:
  - segment status `healthy`,
  - segment fresh watch and migration confidence above threshold,
  - no unresolved critical blocker in target segment,
  - evidence window at least `2x` configured continuity interval.
- On blocker:
  - write evidence bundle (`control_plane_event_envelope`-style record in status payload and completion trace links),
  - freeze only the impacted segment,
  - expose `next_retry_at` with anti-flap cooldown.
- Recovery sequencing:
  - require two consecutive healthy samples before auto unfreeze,
  - move segment through `warn -> healthy`.

### 3. Torghut hypothesis profitability mesh

Define explicit profit hypotheses as first-class contracts in the control plane:

- hypothesis tuple:
  - `hypothesis_id` (`uuid`),
  - `strategy_family`,
  - `target_regime` (`range|trend|crash_hedge|macro_event`),
  - `primary_metric` (`sharpe`, `return`, `dd_abs`, `slippage_p95`, `hit_rate`),
  - `expected_minimum_effect` and confidence threshold,
  - `evidence_policy`: sample window, minimum continuity ratio, freshness window, and minimum evidence windows.
- lane progression states:
  - `shadow -> canary -> live -> scale -> protect -> decommission`.
- automatic transitions:
  - canary requires two consecutive clean evidence windows,
  - live requires both continuity and drawdown budget checks,
  - repeated violations in two consecutive windows force `degrade` and cap freeze for that hypothesis only.

### 4. Measurable trading hypotheses (baseline set for initial plan)

H1 Momentum Decay Guardrail: In low-volatility ranges, a protected microstructure hypothesis (`h-momentum-range`) must show:

- 14-day ex-ante Sharpe uplift `>= 0.10`,
- drawdown inflation `<= 1.20x` relative to baseline,
- `slippage_p95 <= 6.0 bps`.

H2 Cross-Session Continuity: In open/close overlap periods, a hedging hypothesis (`h-overnight-hedge`) must maintain:

- minimum two clean evidence windows with continuity ratio `>= 0.95`,
- mean reversal capture uplift `>= 0.4x` prior window baseline,
- no more than two `critical` continuity drops in any 24h rolling window.

H3 Regime-Switch Survivability: In high-volatility stress windows, any hypothesis promoted to `live` must show:

- hit-rate uplift `>= 3ppt` over control for at least three consecutive live mini-windows,
- adverse slippage median `< 5 bps`,
- loss rate under stress window reduction trend `>= -20%` relative to shadow.

For each hypothesis, violation of any guardrail in two consecutive windows triggers immediate demotion to `degrade`, capital freeze for that hypothesis, and operator review before re-entry.

### 5. Shared rollout/portfolio guardrails

- Per-hypothesis concentration cap: at most `X` hypotheses can remain in `live` concurrently per regime.
- Per-market cap: no more than one live hypothesis can simultaneously consume more than `Y%` of capital across same-day windows.
- Portfolio stop rule: two live hypotheses with concurrent confidence `low` for >`15m` triggers portfolio pause and forced staged rollback for the weakest continuity hypothesis.
- All changes require event-linked reason IDs and explicit operator-readable rationale.

## Validation and evidence gates

### Engineering gates for merge readiness

- Unit tests proving segment-isolated block semantics:
  - `blocked` in one segment does not block healthy transition in other segments.
- Regression tests for demotion thresholds:
  - two consecutive critical windows demote hypothesis to `degrade` and prevent `scale`.
- Status response contract tests:
  - `/ready` and `/control-plane/status` surfaces include segment envelope and hypothesis mesh fields.
- Snapshot tests for evidence bundle payload shape and evidence retention policy.

### Deployer gates for production transition

- staged drill where one options-related segment is forced blocked:
  - other segments remain functional,
  - no global freeze.
- one evidence-driven hypothesis demotion:
  - occurs automatically after two violations,
  - evidence IDs are emitted in one traceable chain.
- one controlled rollback:
  - scoped by hypothesis and segment,
  - requires explicit clear operator event before next transition.

## Rollout and rollback expectations

- Rollout order:
  - segment-aware readiness contract first,
  - canary in one hypothesis family,
  - limited live in low-risk regime,
  - portfolio-scale expansion after both segment and hypothesis acceptance windows pass.
- Rollback:
  - segment rollback is local and preserves unrelated live operations,
  - hypothesis rollback is local with capital reassignment and continuity score reset,
  - evidence replay is mandatory before any reattempt.

## Handoff contract for engineer and deployer

Engineer deliverables:

1. implement or wire the segment trust envelope in Jangar status and orchestration paths,
2. introduce hypothesis-policy evaluation service in Torghut promotion path,
3. add matrix tests for mixed segment and mixed-lane failure recovery,
4. publish deterministic evidence bundles in readiness/trace outputs,
5. update design docs with measured hypothesis acceptance thresholds and rollback criteria.

Deployer deliverables:

1. enforce one segment and one hypothesis change per rollout wave,
2. keep scoped rollback drills in normal-day operations,
3. verify evidence bundle lineage before capital increments,
4. block full rollout if any continuity or backup risk condition is unresolved.

## Why this is explicit architecture, not a patch

This design replaces implicit control behavior with explicit state. Segment trust and hypothesis mesh both become explicit state machines with machine-readable outputs, making recovery and promotion deterministic and auditable instead of procedural.
