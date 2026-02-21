# Torghut Design System v5: Production Quant + LLM Strategy Build Pack

## Status
- Version: `v5`
- Date: `2026-02-21`
- Maturity: `production-quality design pack`
- Scope: 5 prioritized new-feature strategy builds plus whitepaper synthesis

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

## Recommended Build Order
1. `02-conformal-uncertainty-and-regime-gates.md`
2. `01-tsfm-router-refinement-and-uncertainty.md`
3. `03-microstructure-execution-intelligence.md`
4. `05-fragility-aware-regime-allocation.md`
5. `04-llm-multi-agent-committee-with-deterministic-veto.md`

## Why This Sequence
- uncertainty gates are foundational controls for every downstream model path.
- TSFM routing/refinement upgrades signal quality once gating exists.
- execution intelligence captures realized PnL improvements by lowering slippage/impact.
- fragility-aware allocation protects tails before wider autonomy.
- committee-style LLM orchestration is highest complexity and should sit on hardened controls.
