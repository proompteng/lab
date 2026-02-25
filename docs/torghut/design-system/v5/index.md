# Torghut Design System v5: Production Quant + LLM Strategy Build Pack

## Status

- Version: `v5`
- Date: `2026-02-25`
- Maturity: `production-quality design pack`
- Scope: 5 prioritized new-feature strategy builds plus whitepaper synthesis plus crypto pipeline migration design plus multi-account execution migration design

## Purpose

This pack expands the top 5 strategy priorities into implementation-grade designs with:

- explicit architecture and data contracts,
- deterministic safety boundaries,
- rollout, rollback, and SLO gates,
- verification plans and acceptance criteria,
- direct citations to original white papers.

## Non-Negotiable Invariants

- `paper` remains default mode; live requires explicit gates and approval token flow.
- deterministic risk/kill-switch controls remain final authority.
- LLM components can propose, critique, and abstain but cannot bypass deterministic execution policy.
- each promotion decision must include reproducible evidence artifacts.

## Document Set

1. `01-tsfm-router-refinement-and-uncertainty.md`
2. `02-conformal-uncertainty-and-regime-gates.md`
3. `03-microstructure-execution-intelligence.md`
4. `04-llm-multi-agent-committee-with-deterministic-veto.md`
5. `05-fragility-aware-regime-allocation.md`
6. `06-whitepaper-technique-synthesis.md`
7. `07-autonomous-research-to-engineering-pipeline.md`
8. `08-leading-quant-firms-public-research-and-systems-2026-02-21.md`
9. `09-fully-autonomous-quant-llm-torghut-novel-alpha-system.md`
10. `10-crypto-market-data-pipeline-production-design-2026-02-22.md`
11. `11-multi-account-trading-architecture-and-rollout-2026-02-22.md`
12. `12-dspy-framework-adoption-for-quant-llm-autonomous-trading-2026-02-25.md`

## Source-Verified Implementation Snapshot (2026-02-23)

- `01-tsfm-router-refinement-and-uncertainty.md`: Implemented (partial). Router/refinement/fallback paths and tests exist, and runtime uncertainty gate action handling is now wired in the trading scheduler.
- `02-conformal-uncertainty-and-regime-gates.md`: Implemented (partial). Uncertainty gate outputs (`pass/degrade/abstain/fail`) and promotion checks are wired, with runtime execution-path enforcement covered in scheduler logic and trading-pipeline tests.
- `10-crypto-market-data-pipeline-production-design-2026-02-22.md`: Implemented (partial). Desired-symbol fetch failure metrics and alerting are now wired (`ForwarderMetrics` + `TorghutWSDesiredSymbolsFetchFailing`); remaining work is full cutover/rollout validation.
- `11-multi-account-trading-architecture-and-rollout-2026-02-22.md`: Implemented (partial, feature-flagged). Account registry, per-account scheduler lanes, account-scoped idempotency/cursor constraints, and trade-updates v2 dual-read are merged; runtime keeps `TRADING_MULTI_ACCOUNT_ENABLED=false` by default.

## Recommended Build Order

1. `02-conformal-uncertainty-and-regime-gates.md`
2. `01-tsfm-router-refinement-and-uncertainty.md`
3. `03-microstructure-execution-intelligence.md`
4. `05-fragility-aware-regime-allocation.md`
5. `04-llm-multi-agent-committee-with-deterministic-veto.md`
6. `07-autonomous-research-to-engineering-pipeline.md`
7. `12-dspy-framework-adoption-for-quant-llm-autonomous-trading-2026-02-25.md`
8. `09-fully-autonomous-quant-llm-torghut-novel-alpha-system.md`

## Why This Sequence

- uncertainty gates are foundational controls for every downstream model path.
- TSFM routing/refinement upgrades signal quality once gating exists.
- execution intelligence captures realized PnL improvements by lowering slippage/impact.
- fragility-aware allocation protects tails before wider autonomy.
- committee-style LLM orchestration is highest complexity and should sit on hardened controls.
- two-speed pipeline operationalizes continuous intake while keeping production promotion strictly gated.
- DSPy adoption should come after committee/gate hardening so optimizer-driven LLM programs inherit deterministic governance and Jangar-native run control.
- full-autonomy design should be evaluated as an advanced track after two-speed controls are proven.
