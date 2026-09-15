# Financial RAG and Time-Series Memory Architecture

## Objective

Build a finance-specific RAG + time-series memory stack so Torghut LLM paths can ground reasoning in recent market
context, historical similar regimes, and validated system telemetry.

## Why This Matters

Recent finance RAG and time-series memory work suggests that retrieval quality and temporal memory controls are more
important than raw model size for decision reliability.

## Proposed Torghut Design

- Add `MarketMemoryStoreV4` with three lanes:
  - structured fundamentals/events,
  - recent high-frequency telemetry,
  - historical analog windows.
- Add retrieval quality metrics (hit relevance, staleness, contradiction score).
- Require memory provenance in every LLM recommendation.

## Owned Code and Config Areas

- `services/torghut/app/trading/llm/**`
- `services/jangar/src/routes/api/torghut/**`
- `schemas/embeddings/memories.sql`
- `docs/torghut/design-system/v3/jangar-market-intelligence-and-lean-integration-plan.md`

## Deliverables

- Memory schema and retrieval API contracts.
- Provenance-aware prompt assembly with conflict detection.
- Evaluation harness for retrieval precision and staleness.
- Runbook for memory invalidation and hotfix rollback.

## Verification

- Retrieval precision and recency SLOs pass on benchmark suites.
- Recommendation quality improves over non-RAG baseline.
- Contradictory context detection blocks unsafe recommendations.

## Rollback

- Disable RAG augmentation and use deterministic prompt baseline.
- Keep memory ingestion active for offline diagnostics.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v4-financial-rag-memory-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `memorySchemaPath`
  - `artifactPath`
- Expected artifacts:
  - memory schema/API updates,
  - retrieval evaluation report,
  - rollback runbook updates.
- Exit criteria:
  - retrieval SLOs pass,
  - provenance attached to all recommendations,
  - safety blocks validated.

## Research References

- FinSrag: https://arxiv.org/abs/2502.05878
- TiMi: https://arxiv.org/abs/2505.16043
- FinTMMBench: https://arxiv.org/abs/2503.05185
