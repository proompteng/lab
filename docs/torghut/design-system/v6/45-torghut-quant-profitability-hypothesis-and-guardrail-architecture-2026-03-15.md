# Torghut quant profitability architecture and guardrail contract (2026-03-16)

## Objective and success criteria

Primary objective

- Increase measurable profitability without increasing tail risk.
- Convert hypothesis progression into a hypothesis-evidence-and-budget contract with machine-readable proofs.
- Keep strategy risk bounded during mixed market and mixed signal regimes.

Success criteria

- Canary expectancy must be positive on 3 consecutive evidence windows before any live capital increase.
- Scale-up is blocked when continuity, freshness, or drawdown controls fail.
- Reduce time-to-decline after evidence deterioration to under 30 minutes.
- Increase percentage of hypotheses with complete evidence artifacts by at least 20% in one quarter cycle.

## Evidence snapshot (as of 2026-03-16)

### Cluster and rollout evidence

- Torghut sim/test lanes continue to show rollout friction (`Unhealthy` startup/readiness, probe 503, and job exceptions) during rapid revision churn.
- `torghut-ta-sim` shows periodic `flink` task failures and JDBC write failures in event stream history.
- Restore jobs report `ErrorNoBackup` in `torghut-db-restore`, confirming backup lineage is a practical continuity risk for empirical evidence generation.

### Source assessment

- The core hypothesis contract is present in `services/torghut/app/trading/hypotheses.py` but admission controls still need more explicit capital routing signals.
- Evidence and state surfaces exist in `services/torghut/app/main.py` (`/trading/status`, `/trading/empirical-jobs`, `/db-check`) and can absorb richer contract fields without broad schema churn.
- `services/jangar/src/server/torghut-quant-metrics.ts` already computes freshness and status counters but does not yet enforce per-hypothesis capital deallocation semantics.

### Database / data consistency evidence

- Data-quality gates are still partially process-derived; full cluster-side checks for evidence continuity are not yet enforced before transitions.
- Missing `db-check` continuity in some promotion contexts means stale data can survive longer than intended.

## Architecture alternatives

### Alternative A: Keep fixed global promotion gates and only add dashboards

Pros

- Easy rollout.
- Lower schema coupling.

Cons

- Fails to handle regime and symbol-specific decay.
- Promotes hypotheses with uneven evidence under aggregate windows.

### Alternative B: Static capital slices with manual review only

Pros

- Predictable and easy to audit.
- Minimal code impact.

Cons

- Slow reaction to drawdown or concept drift.
- No automatic deallocation from evidence decay.

### Alternative C: Evidence-budgeted profitability mesh with explicit kill/degrade transitions (chosen)

Pros

- Allocates capital by objective evidence quality and risk profile.
- Handles mixed regime behavior with explicit budgets and anti-concentration controls.
- Enables automatic deallocation with reproducible reasons.

Cons

- More state and tests required.
- Operational teams must tune gate thresholds over first two cycles.

### Alternative D: Replace current hypothesis stack with external allocation engine

Pros

- Potentially cleaner abstraction.

Cons

- Significant migration cost and integration risk during discovery stage.

## Decision

Choose Alternative C.

Implement explicit, machine-readable hypothesis and budget contracts with conservative defaults, staged transitions, and automatic downgrade behavior.

## Architecture design

### 1) Hypothesis lifecycle contract

Each hypothesis must move through:

- `shadow` (no live capital)
- `canary` (bounded capital cap)
- `live` (controlled capital bucket)
- `degrade` (forced reduction)

Transition condition bundle:

- `sample_count`, `expectancy_rolling`, `evidence_continuity_ratio`, `freshness_sla`, and `drawdown_guard`.
- `manifest_fingerprint` and `feature_fingerprint` must match for repeated transitions.

### 2) Profitability mesh and capital budgets

Introduce budget controls per regime and hypothesis family:

- global max live capital percent,
- per-hypothesis max percent,
- per-regime max concentration,
- max symbol overlap,
- kill-switch on two consecutive negative evidence checkpoints.

Lane defaults (starter values to be tuned in plan stage):

- shadow: 0%
- canary: up to 15% of live budget with hard cap per hypothesis
- live: up to remaining budget with active anti-concentration constraints

### 3) Evidence continuity and freshness

A hypothesis cannot scale if any of these fail:

- missing evidence for last N runs,
- stale ta-feature lineage beyond threshold,
- missing execution manifests,
- confidence drop without recovery in two windows.

Degrade action rules:

- first breach: downgrade from live to canary,
- second consecutive breach: force shadow,
- third breach: maintain shadow and emit explicit `kill` advisory.

### 4) Guardrail model

Add explicit reasons and counters in status contract:

- `rule` (`expectancy`, `freshness`, `concentration`, `overlap`, `drawdown`),
- `value` and `threshold`,
- `evidence_windows` used,
- `next_check_at`,
- `action_taken` (`downgrade`, `pause`, `halt_scale`).

## Test and validation model

### Required regression tests

Engineering will add tests for:

- hypothesis transition ladder under mixed signal drift,
- concentration and overlap budget caps,
- continuous evidence decay and auto-degrade,
- no-regression scenario where unchanged hypothesis stays live when all windows pass.

### Operational gates

- Discovery evidence gate: full assessment artifacts included in PR description and signed with concrete acceptance steps.
- Stage handoff gate: engineer must show evidence of transition tests and status contract fields.
- Production pilot gate: one canary hypothesis completes 3 evidence windows at canary level with no kill triggers.

## Rollout and rollback contract

Rollout phases

1. Publish design contract and schema map.
2. Add contract fields in `services/torghut/app/main.py`, hypothesis policy in `services/torghut/app/trading/hypotheses.py`, and contract reader in `services/jangar/src/server/torghut-quant-runtime.ts`.
3. Run staged canary in `discover`-mirrored scope.
4. Promote to broad canary if the gate windows remain green for 1 full cycle.
5. Permit `live` scale for one hypothesis family at a time.

Rollback behavior

- On any two consecutive negative canary windows: auto-revert to shadow and pause scaling.
- Persist rollback reason with rule, timestamp, and evidence window for audit replay.
- If multiple lanes breach simultaneously, prefer hypothesis-wide hard cap enforcement before kill decisions.

## Handoff expectations

Engineering

- Implement hypothesis contracts, budget guards, and evidence continuity checks.
- Extend tests around ladder transitions and forced downgrades.
- Keep contract fields backwards-compatible for one release window.

Deployer

- Roll out one hypothesis family canary-first.
- Publish dashboard cards for lane transitions, continuity score, and kill triggers.
- Verify no rollback action leaves healthy segments without capital caps.
