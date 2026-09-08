# 41. Profitability Hypothesis Mesh and Guardrail Architecture for Torghut Quant (2026-03-15)

## Status

- Date: `2026-03-15`
- Maturity: `architecture decision + implementation contract`
- Owner: `torghut-quant swarm architecture stage`
- Scope: Torghut hypothesis lifecycle, empirical proof granularity, and profit-constrained capital ramp rules
- Depends on:
  - `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
  - `docs/torghut/design-system/v6/32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
  - `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`

## Why this doc exists

The current Torghut readiness contract is still aggregate-first. That design is useful for uptime, but weak for profitability governance.

Current behavior ties multiple hypotheses to one set of process counters and leaves promotion with reduced interpretability. This is the same failure that causes:

- `promotion_eligible_total` to look zero while real process windows are partially useful,
- independent hypotheses to block one another due to shared counters,
- and empirical absence to be inferred indirectly from missing live counters.

This design introduces a hypothesis mesh with measurable profitability gates and explicit divergence rules.

## Problem statement

Three risks are currently highest:

1. **Counter collapse:** counters across families merge evidence quality into one integer path.
2. **No portfolio of hypotheses:** a single stale indicator can disable all hypotheses, including those with independent evidence.
3. **No measurable profit guardrail by lane:** promotion decisions do not enforce post-cost profitability and run-cost discipline at each evidence window.

## Evidence snapshot (March 15, 2026)

- Source surface: `services/torghut/app/trading/hypotheses.py` still computes readiness from process counters (for example `feature_batch_rows_total`, `drift_detection_checks_total`) and uses shared reasons.
- Source surface: `services/torghut/app/main.py` surfaces these counters in health payloads, but no dedicated hypothesis proof lineage is yet contract-bound to every stage.
- Source surface: `services/jangar/src/server/torghut-quant-status.ts` does not yet expose independent per-hypothesis profitability evidence state.
- Database surface: migration history includes governance and empirical-job artifacts, but no dedicated per-hypothesis proof window/fitness tables for production guardrails in the latest schema lineage.

## Alternatives considered

### Option A. Keep aggregate counters and add more threshold tuning

- Pros: minimal changes.
- Cons: does not create per-hypothesis isolation or robust profitability attribution, so low-margin hypotheses can be masked by healthy families.

### Option B. Centralize everything in Jangar with a single promotion gate

- Pros: single visibility point.
- Cons: increases control-plane coupling and does not preserve Torghut-native profitability policy boundaries.

### Option C. Chosen. Hypothesis mesh with profitability-first proof windows and explicit risk envelope

Keep Torghut as authority for profitability while giving Jangar a durable evidence source of readiness state. This keeps execution and research boundaries intact and enables measurable cross-hypothesis behavior.

## Decision

Adopt a three-layer profitability architecture:

1. **Hypothesis contract layer** for independent evidence windows and blockers.
2. **Profit envelope layer** for post-cost expectancy, max drawdown, and execution quality controls.
3. **Capital controller layer** that gates allocation per hypothesis by weighted confidence and risk state.

This allows profitable hypotheses to remain active while unprofitable or under-proven ones hold or shrink.

## Architecture

### 1) Hypothesis proof windows

Define per-hypothesis persisted windows:

- `hypothesis_profit_windows`:
  - `hypothesis_id`,
  - `window_id`,
  - `window_start`, `window_end`,
  - `feature_coverage` by family and symbol set,
  - `continuity_score`,
  - `market_context_state`,
  - `empirical_refs`,
  - `signal_quality_score`,
  - `created_at` + `source_ref`.
- `hypothesis_profit_readiness`:
  - `hypothesis_id`,
  - `window_id`,
  - `readiness_state` (`ready`, `blocked`, `degraded_last_good`, `failed`),
  - `degrade_reason_set`,
  - `proof_ttl_seconds`,
  - `next_review_at`.

### 2) Profitability hypotheses and measurable guardrails

Each hypothesis publishes explicit measurable hypotheses with minimum acceptance values before canary:

- **H1: Market-context continuity hypothesis**
  - minimum continuity score threshold,
  - max tolerated missing-domain ratio,
  - stale bundle penalty curve by domain.
- **H2: Signal-to-slippage hypothesis**
  - post-cost expectancy must be positive across at least `N` trades in the proof window,
  - realized slippage must remain below a configurable percentile envelope,
  - order rejects and fallback ratio must stay below threshold.
- **H3: Regime transfer hypothesis**
  - no promotion from one regime profile to another without independent proof refresh,
  - regime confusion score must improve versus last-good evidence.

These hypotheses are testable and explicit enough for engineering and deployers to monitor independently.

### 3) Capital envelope and allocation coupling

Capital controller uses per-hypothesis budgets:

- `base_alloc_pct` from governance baseline,
- `profit_guardrail_multiplier` from recent proof quality,
- `empirical_job_validity_ratio` multiplier,
- `confidence_clip` when evidence freshness degrades.

No single counter can disable all hypotheses anymore; each hypothesis has independent readiness plus a capped global safety floor.

### 4) Proof refresh and canary policy

- proof windows must refresh before any capital-up decision.
- canary promotion for any hypothesis requires:
  - fresh proof window,
  - at least one positive post-cost trade cohort,
  - no critical guardrail violations.
- a blocked hypothesis can still feed feature ranking telemetry, but must not consume new capital.

## Implementation contract

### Engineering stage

1. Add persistence for the two tables above in Torghut migration path.
2. Write proof windows from runtime evidence producers and attach empirical-job family refs.
3. Expose `proof_window_id`, `proof_score`, and `readiness_state` in `/trading/status` and `/trading/health`.
4. Refactor readiness reasons in `services/torghut/app/trading/hypotheses.py` to reason from proof windows first, counters as telemetry.
5. Implement hypothesis-level capital control in scheduler paths with explicit dealloc-on-block actions.

### Validation gates (engineering)

- Hypothesis readiness must diverge by family in at least one session window without cross-hypothesis bleed.
- A hypothesis blocked by empirical-job absence must report that reason directly and not rely on opaque aggregate counters.
- Post-cost profitability and slippage guardrails reject promotion even if process counters appear healthy.
- Rollback behavior keeps persisted proof windows and surfaces stale but traceable reasons.

### Deployer stage

1. Deploy proof write path in dual-write mode for one full US session.
2. Enable proof-backed readiness in shadow mode and compare reason maps with legacy view.
3. Enable canary capital controls for one hypothesis at a time.

## Rollout plan

1. **Wave 1 (ledger + contracts):** dual-write proof windows and readiness rows.
2. **Wave 2 (shadow read):** maintain legacy reasons alongside proof-based reasons.
3. **Wave 3 (proof-first):** use proof readiness for scheduler/capital decisions.
4. **Wave 4 (guardrail tightening):** progressively enforce post-cost profitability and drawdown thresholds.

## Rollback plan

- Disable proof-first mode and switch back to legacy counters if proof freshness mismatch exceeds session tolerance.
- Pause any hypothesis that entered proof-ready without sufficient empirical refresh.
- Retain all proof windows and readiness rows for forensic comparison.

## Risks

- Migration load if proof windows are produced at too granular a resolution.
- Overfitting to short windows if window size policies are not regime-aware.
- Hypothesis-specific deallocations can increase operational complexity if not explained in operator dashboards.
- Guardrail strictness can over-prune in volatile sessions if envelope parameters are not adaptive.

## Expected outcomes

- Measurable profitability gates become first-class contract terms.
- Multiple hypotheses can be evaluated and traded independently.
- Promotion and capital decisions become auditable by proof lineage, not by opaque runtime counters.

## Engineer handoff acceptance

1. Proof window persistence and proof-based hypothesis readiness are implemented and observable.
2. `/trading/status` and `/trading/health` provide proof lineage and readiness states with timestamped evidence refs.
3. Capital scheduler uses hypothesis-level decisions with explicit dealloc controls.
4. At least one session validates divergent readiness between two hypotheses under mixed evidence conditions.

## Deployer handoff acceptance

1. At least one session runs with proof-first scheduler for a controlled subset.
2. Guardrails show explicit reject reasons for post-cost expectancy, drawdown, or slippage breaches.
3. No hard capital lockout occurred from unrelated hypothesis failure states.
4. Rollback toggles are documented and can be exercised without schema mutation.
