# Financial RAG and Time-Series Memory Architecture

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Torghut GitOps, migrations, release workflows, and scripts exist; post-deploy verification wiring has changed over time.
- Matched implementation area: CI/CD, release, GitOps, Argo, Knative, and deployment automation.
- Current source evidence:
  - `argocd/applications/torghut/knative-service.yaml`
  - `argocd/applications/torghut/db-migrations-job.yaml`
  - `.github/workflows/torghut-ci.yml`
  - `.github/workflows/torghut-release.yml`
  - `packages/scripts/src/torghut/update-manifests.ts`
- Design drift note: Deployment docs must be checked against current workflows because old names have been retired or replaced.


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
