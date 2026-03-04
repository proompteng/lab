# Emergency Stop Reason Normalization and Recovery Stability

## Status

- Type: ADR/design proposal
- Date: `2026-03-04`
- Source of truth: `services/torghut/app/trading/scheduler.py`
- Scope: torghut safety controls and emergency-stop signal handling
- Evidence basis: cluster rollout events, scheduler safety state machine, and targeted regression tests

## Objective

Reduce operational noise and improve recovery determinism by making emergency-stop reason strings canonicalized, deduplicated, and order-stable without changing existing emergency stop semantics.

## Problem

`TradingScheduler` stores emergency-stop reasons as semicolon-delimited free-form strings and then recomputes these lists during recovery.

Observed risks:
- duplicate reasons can be appended repeatedly after recoverable/nonrecoverable transitions,
- whitespace and malformed fragments can survive through reason parsing,
- repeated set sorting can change ordering between incidents and make incident evidence harder to compare,
- duplicate or messy reason strings can amplify false-change alerts in evidence review.

## Design decision

Implement a single canonicalization path for emergency-stop reason handling.

1) Parse and normalize all semicolon-delimited reason strings through a shared helper.
2) Deduplicate by first-seen order while trimming whitespace.
3) Reuse that normalized representation in both trigger and recovery paths.

This keeps behavior identical from a control perspective (emergency stop still engages whenever reasons are present) while making reason bookkeeping deterministic and cleaner.

## Alternatives considered

### Option A: Keep current behavior unchanged
- Pros: zero code movement and zero regression risk.
- Cons: keeps flaky reason ordering and duplicate history across retries, which complicates post-incident comparisons and escalation heuristics.

### Option B: Sort unique reasons in recovery and trigger paths
- Pros: deterministic ordering regardless of source order.
- Cons: lexical ordering hides causal sequence, which makes operator-readable incident trails harder to infer at glance.

### Option C: Introduce structured reason objects (id/type/severity metadata) in DB + runtime
- Pros: future extensibility and stronger typing.
- Cons: larger schema/runtime surface and migration cost not proportional to current objective.

### Selected: Option C avoided, Option B avoided, implemented Option D (shared canonical list helper)
- Canonicalization with dedupe by first-seen order is minimal, safe, and solves the highest-risk operational ambiguity.

## Implementation

- Added `app.trading.scheduler._merge_emergency_stop_reasons`.
- Updated `_split_emergency_stop_reasons` to use the canonical merge helper.
- Updated `_evaluate_emergency_stop_recovery`:
  - merge latched + current non-recoverable reasons without duplicate loss,
  - refresh recoverable reason set without duplicate or whitespace artifacts.
- Updated `_trigger_emergency_stop` to store canonicalized reason strings.
- Added regression tests:
  - `test_split_emergency_stop_reasons_ignores_duplicates_and_whitespace`
  - `test_emergency_stop_recovery_canonicalizes_and_merges_nonrecoverable_reasons`

## Risk and impact

- Risk: whitespace trimming and dedupe may collapse reasons that relied on leading/trailing spaces for local distinction. No code path intentionally encodes semantic differences this way.
- Risk: unchanged reasons still remain semicolon strings; richer schema evolution remains future work.

## Rollout and verification

- Unit tests for scheduler safety now encode the new behavior.
- Runtime verification remains read-only during this mission: compare `/trading/status` and rollback incident evidence before/after deployments for reduced reason churn and stable ordering.

## Exit criteria

- New helper and reason-path updates are merged.
- Regression tests cover normalization and recovery merge behavior.
- Design and mission artifacts include rationale, alternatives, and handoff notes.
