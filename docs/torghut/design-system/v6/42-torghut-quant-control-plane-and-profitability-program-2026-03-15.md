# 42. Torghut Quant Control-Plane Reliability and Profitability Expansion Program (2026-03-15)

## Status

- Date: `2026-03-15`
- Stage: `architecture plan + implementation contract`
- Maturity: `production-quality design artifacts`
- Scope:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/torghut-quant-metrics.ts`
  - `services/jangar/src/server/torghut-quant-runtime.ts`
  - `services/torghut/app/{hypotheses.py, trading/*.py}`
  - `docs/torghut/design-system/v6/{39..41}.md`
- Primary objective:
  - reduce blast radius of control-plane regressions,
  - convert persistent profitability stasis into measurable, bounded progression,
  - keep fail-closed promotion while enabling useful partial work in stable lanes.

## Baseline assessment: cluster, source, and database state

### Cluster assessment

- `kubectl -n torghut get pods` and `kubectl -n jangar get pods` are steady with all core services running and no cross-namespace crash loops.
- Recent non-normal events show non-fatal control-plane perturbations that are clustered, not global:
  - `Unhealthy` probe failures on `torghut-00134-deployment` readiness/liveness,
  - `ErrorNoBackup` warnings on `cluster/torghut-db-restore` and `cluster/jangar-db-restore`,
  - repeated `UpdateCompleted` churn on ClickHouse config objects.
- Service graph remains healthy for rollout and runtime paths:
  - Knative-style stable `torghut`/`torghut-sim` gateways still front service variants (`torghut-00134`, `torghut-00134-private` etc.),
  - no deployment-level crash-loop storms visible from the current pod inventory.

### Source assessment

- `services/jangar/src/server/control-plane-status.ts` already models dependency quorum and readiness degradation reasons, but there are explicit global-effect coupling points (`watch_reliability_degraded`, aggregate degraded output) that can still fan out from localized fault windows.
- `services/jangar/src/server/torghut-quant-metrics.ts` still relies partly on query-derived freshness pathways and no persisted segment authority surface for readiness consumers.
- `services/torghut/app/trading/hypotheses.py` centralizes readiness and promotion decisions and has good contract coverage in tests, but currently lacks lane-level profitability budgeted transitions for independent hypothesis progress.
- Test coverage strengths:
  - robust status/metrics behavior for individual modules (`test_hypotheses`, `test_empirical_jobs`, `test_trading_api`, `test_completion_trace`),
  - control-plane status shadow behavior in `services/jangar/src/server/__tests__/control-plane-status.test.ts`.
- Test gaps identified:
  - missing explicit rollback/rollback-avoidance coverage for mixed-segment fault classes across control-plane and capital-lane boundaries,
  - no end-to-end design-level regression lock showing partial rollout behavior under simulated single-segment jitter.

### Database/data assessment

- Migrations show evidence scaffolding exists but not consistently consumed for all live policy layers:
  - `0023_simulation_run_progress` adds durable simulation progress rows,
  - `0024_simulation_runtime_context` adds runtime context and lane metadata,
  - there is no dedicated persisted hypothesis budget ledger table in the current head for autonomous capital allocation lanes.
- Runtime data contract quality is improving but incomplete operationally:
  - evidence jobs and empirical reports exist in model/test contracts but recurring freshness is not fully reflected in capital progression paths,
  - missing continuity across hypothesis/segment and recurring jobs creates a stable but static promotion floor (`shadow` lock-in in observed status traces).

## Problem definition

Current design intent is strong; failure is mostly coupling behavior:

1. localized control-plane telemetry can still create global degradation signals;
2. profitability progression is not yet organized by measurable, testable lane evidence windows;
3. recovery and downgrade actions are not yet uniformly scoped by segment or hypothesis, so one transient failure can still suppress otherwise stable execution modes;
4. rollout safety and capital growth are separate loops, causing repeated operator ambiguity during incident windows.

This design requires reducing coupling, not relaxing safety.

## Architecture alternatives

### Option A: tighten probe/degrade thresholds only

- Keep global structures unchanged; only tune timeouts, retries, and thresholds.
- Why rejected: high chance of oscillation and masking true segment health while preserving coarse-grained failure blast radius.

### Option B: fully centralize all decisions in Jangar

- Convert all readiness, evidence, and promotion semantics into one control-plane authority plane.
- Why rejected: removes Torghut-specific strategy context and weakens deterministic hypothesis-level controls during partial data availability.

### Option C: segment authorities + lane-capital gates (chosen)

- Split control-plane signals into explicit segments with explicit scope tags,
- bind profitability progression to hypothesis-specific proof lanes with budget and demotion guardrails,
- define shared engineer/deployer validation and rollback playbooks before rollout broadening.

## Decision

Adopt the `Segmented Control + Lane Capital` design family:

- segmented control-plane readiness in Jangar with segment-local degraded states and explicit degradation scopes,
- hypothesis-level profitability proof lanes with measurable windows and explicit budgets,
- explicit one-way rollout lattice: `observe -> gate -> dryrun -> full`, with hard fail-closed promotion.

## Architecture

### 1) Segmented control-plane contract

Create or formalize the following segment categories for status consumers:

- `control_runtime`: rollout, deployment health, and controller continuity,
- `dependency_quorum`: dependency checks and watch health,
- `freshness_authority`: producer-authored event freshness for readiness truth,
- `evidence_authority`: empirical families and continuity freshness,
- `market_data_context`: market context and feature bundles relevant to specific hypotheses.

Each segment has:

- `status` (`healthy` / `degraded` / `blocked`),
- `scope` (`global` / `capital_family` / `hypothesis_scoped` / `single_capability`),
- `confidence` (`high` / `medium` / `low`),
- `as_of`, `observed_at`, and reason taxonomy.

Acceptance rule:

- single-segment degradation should not automatically block all hypotheses; only the affected hypothesis/lane or capital family is restricted.

### 2) Hypothesis profitability lanes

Define per-hypothesis lanes with persisted proof state:

- `lane_t1_shadow`, `lane_t1_canary`, `lane_t7_shadow`, `lane_t7_canary`, `lane_t30_live`,
- each lane tracks:
  - evidence maturity (`derived`, `authoritative`, `expired`),
  - required families present (feature quality, empirical authority, market context coverage),
  - risk budget utilization and guardrail breaches.

Promotion constraints:

- `promotion_eligible` only when all required families are authoritative and non-stale for that lane,
- one hypothesis canary can run while other hypotheses remain blocked by segment/lane reasons,
- explicit demotion states are first-class outcomes and preserve auditability.

### 3) Data model and telemetry expectations

- persist lane state and proof artifacts to avoid process-local drift,
- continue using existing migration ledger tables while adding a dedicated persisted allocation table for lane budgets,
- gate API responses (`/trading/status`, `/trading/health`, control-plane payload) to expose:
  - per-hypothesis segment states,
  - per-hypothesis lane budgets,
  - evidence continuity by segment.

### 4) Rollout/rollback lattice

Rollout mode transitions are explicit and observable:

- `observe`: status-only with segment capture,
- `gate`: block promotion for blocked scope, but keep eligible lanes alive,
- `dryrun`: simulated transition path with full metrics parity,
- `full`: production transition only when validation gates pass.

Rollback is scoped:

- rollback one segment/capital lane when mismatch exceeds policy window,
- preserve healthy segments without rollback amplification,
- keep evidence lineage and decision snapshots.

## Implementation contract

### Wave A (Jangar control-plane and source surface)

- implement per-segment outputs and reasons without changing existing global defaults (shadow mode first),
- standardize reason taxonomy for segment-to-hypothesis mapping,
- retain legacy compatibility fields for one release.

Acceptance gates:

- global failures only when no safe segment remains healthy,
- one segment failure does not induce immediate global promotion block,
- `/api/agents/control-plane/status` returns segment-level state.

### Wave B (Torghut profitability lanes)

- define hypothesis lane state schema and API shape in `trading` layer,
- define independent budget counters and demotion transitions,
- wire reasons to lane-specific contract families rather than global counters.

Acceptance gates:

- at least one hypothesis can maintain `shadow` while another transitions independently within eligible lane,
- `promotion_eligible_total` must become non-zero when evidence families for that hypothesis are complete,
- demotion path emits reasoned lineage.

### Wave C (Orchestration and rollout integration)

- bind deployment rollout mode to segment status and lane readiness signals,
- require cross-domain engineer and deployer sign-off before defaulting to full mode,
- finalize runbook drills for partial rollback.

Acceptance gates:

- one-week canary with `observe -> gate -> dryrun` transitions without cross-lane bleed,
- rollout automation never rolls back healthy hypotheses on unrelated segment faults,
- no false-positive global freezes in single-segment stress windows.

## Validation plan

### Automated

- extend control-plane status tests to include mixed-segment failure classes and reason scoping,
- add lane transition tests with independent hypothesis progression,
- add demotion/rule tests for budget and drawdown guardrails.

### Live/system

- run one canary window on `observe -> gate -> dryrun` transitions,
- verify `/api/agents/control-plane/status` and `/trading/status` show segment-scoped degradation and lane budgets,
- verify recovery drill runbooks in both namespaces under synthetic watch-noise.

## Measurable hypotheses

- H1: one localized watch or probe incident should reduce collateral hypothesis blocks by >40% versus the previous global block pattern.
- H2: after recurring empirical jobs are present, at least one non-global promotion movement occurs within two sessions (`shadow -> canary` within lane constraints).
- H3: median time to recover from localized segment faults improves by >35% while maintaining conservative risk budgets.

## Rollout and rollback expectations

Engineer handoff:

- code-level segment schema + lane schema are implemented,
- legacy compatibility mode remains for one release,
- tests for both de-escalation and scoped escalation pass before full rollout.

Deployer handoff:

- cluster rollback drills cover segment rollback and lane rollback independently,
- incident playbook updated with failure-to-scope matrix and evidence-first recovery order,
- no global freeze during single-segment failure in observed sessions.

Rollback hard triggers:

- persistent mismatched segment signal >2 sessions without recovery,
- evidence contradiction >5% between segment status and observed operator telemetry in a session,
- repeated capital-lane false transitions in the same two-session window.

## Final recommendation

Reliability and profitability should scale through segmentation, not simplification.
The architecture path is to make failure domains explicit, make evidence authoritative, and use controlled lane transitions so risk control remains strict while still permitting measured capital recovery.
