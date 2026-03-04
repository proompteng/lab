# Torghut Design System v6: Beyond TSMOM Intraday Autonomy Pack

## Status

- Version: `v6`
- Date: `2026-03-03`
- Maturity: `production-quality design pack`
- Scope: intraday strategy architecture upgrade beyond static TSMOM, with regime-adaptive routing, DSPy-governed LLM reasoning, contamination-safe evaluation, and production rollout controls
- Implementation status: `Completed` (program closure passed against all v6/13 definition-of-done criteria on `2026-03-03`)
- Implementation status (strict): `Implemented=16`, `Partial=0`, `Planned=0` of 16
- Evidence: `13-production-gap-closure-master-plan-2026-03-03.md` (Wave 0-6 closure + DoD)
- Evidence sync: `14-legacy-gap-disposition-map-2026-03-03.md` (signed v4/v5 disposition completeness)
- Rollout status: v6 pack controls are represented by merged runtime/control-plane closure phases in `main` (`#3921` through `#3960`).

## Purpose

Translate the "Beyond TSMOM" research synthesis into implementation-grade Torghut designs that can be executed by engineers and AgentRuns with explicit contracts, safety gates, and rollout criteria.

This pack is positioned as the next architecture layer above:

- `docs/torghut/design-system/v5/12-dspy-framework-adoption-for-quant-llm-autonomous-trading-2026-02-25.md`
- `docs/torghut/design-system/v5/13-fundamentals-news-codex-spark-agent-pipeline-2026-02-26.md`
- `docs/torghut/design-system/v5/14-dspy-jangar-openai-full-rollout-2026-02-27.md`

## Non-Negotiable Invariants

- Deterministic risk and policy controls remain final authority.
- DSPy review runtime uses Jangar OpenAI-compatible endpoints (`/openai/v1/chat/completions`) with spark model for live LLM inference.
- Legacy runtime network LLM call paths are removed from the decision codepath once cutover is complete.
- Contamination-aware, forward-only evaluation is mandatory before promotion.
- Every promotion and rollback action must be evidence-backed and reproducible.

## Document Set

1. `01-beyond-tsmom-system-architecture-and-latency-model.md`
2. `02-regime-adaptive-expert-router-design.md`
3. `03-dspy-llm-decision-layer-over-jangar.md`
4. `04-alpha-discovery-and-autonomous-improvement-pipeline.md`
5. `05-evaluation-benchmark-and-contamination-control-standard.md`
6. `06-production-rollout-operations-and-governance.md`
7. `07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
8. `08-profitability-research-validation-execution-governance-system.md`
9. `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
10. `10-timesfm-foundation-model-router-parity.md`
11. `11-deeplob-bdlob-microstructure-intelligence.md`
12. `12-posthog-agent-observability-and-error-tracking-production-design.md`
13. `13-production-gap-closure-master-plan-2026-03-03.md`
14. `14-legacy-gap-disposition-map-2026-03-03.md`
15. `15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
16. `16-dspy-llm-live-gate-root-cause-and-rollout-2026-03-04.md`
17. `16-emergency-stop-reason-normalization-and-recovery-consistency-2026-03-04.md`
18. `17-emergency-stop-reason-normalization-and-recovery-stability-2026-03-04.md`
19. `18-trading-readiness-and-rollout-stability-2026-03-04.md`
20. `19-jangar-symbol-dependency-freshness-and-readiness-guard.md`
20. `20-trading-allocator-config-surface-hardening-2026-03-04.md`
21. `21-schema-fingerprint-and-freshness-for-database-readiness-2026-03-04.md`
22. `22-trading-readiness-dependency-freshness-cache-2026-03-04.md`
23. `23-readiness-schema-drift-diagnostics-2026-03-04.md`
24. `23-trading-startup-readiness-warmup-2026-03-04.md`

## Recommended Build Order

1. `05-evaluation-benchmark-and-contamination-control-standard.md`
2. `08-profitability-research-validation-execution-governance-system.md`
3. `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
4. `01-beyond-tsmom-system-architecture-and-latency-model.md`
5. `10-timesfm-foundation-model-router-parity.md`
6. `11-deeplob-bdlob-microstructure-intelligence.md`
7. `02-regime-adaptive-expert-router-design.md`
8. `03-dspy-llm-decision-layer-over-jangar.md`
9. `04-alpha-discovery-and-autonomous-improvement-pipeline.md`
10. `06-production-rollout-operations-and-governance.md`
11. `12-posthog-agent-observability-and-error-tracking-production-design.md`
12. `07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
13. `13-production-gap-closure-master-plan-2026-03-03.md`
14. `14-legacy-gap-disposition-map-2026-03-03.md`
15. `15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
16. `16-dspy-llm-live-gate-root-cause-and-rollout-2026-03-04.md`
17. `16-emergency-stop-reason-normalization-and-recovery-consistency-2026-03-04.md`
18. `17-emergency-stop-reason-normalization-and-recovery-stability-2026-03-04.md`
19. `18-trading-readiness-and-rollout-stability-2026-03-04.md`
20. `19-jangar-symbol-dependency-freshness-and-readiness-guard.md`
20. `20-trading-allocator-config-surface-hardening-2026-03-04.md`
21. `21-schema-fingerprint-and-freshness-for-database-readiness-2026-03-04.md`
22. `22-trading-readiness-dependency-freshness-cache-2026-03-04.md`
23. `23-readiness-schema-drift-diagnostics-2026-03-04.md`
24. `23-trading-startup-readiness-warmup-2026-03-04.md`

## Why This Sequence

- Evaluation correctness and contamination safety must be locked first to avoid optimizing to invalid signals.
- Profitability must be treated as an operating system with strict stage contracts from research through governance.
- External benchmark parity should be established before broadening model families and execution intelligence.
- System architecture and routing design define data contracts used by the LLM and alpha-evolution layers.
- DSPy decision integration must be implemented on top of stable routing and deterministic gate interfaces.
- Autonomous strategy evolution should only be promoted after evaluation and serving contracts are stable.
- Production rollout and governance closes with explicit SLO, rollback, and incident controls.
- PostHog observability design is sequenced late to instrument stable runtime paths and avoid telemetry contract churn.
