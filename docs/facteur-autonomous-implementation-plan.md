# Facteur Autonomous Implementation Plan (2025-10-30)

This plan operationalises the autonomous knowledge base, schema, and vector strategies. Each milestone references a unique TODO marker (e.g. `TODO(codex-autonomy-step-01)`) that is mirrored in the code scaffolding for low-conflict incremental development.

## Phase 1 – Runtime Data Ingestion

- [x] `TODO(codex-autonomy-step-01)`: Wire new `codex_kb` tables into the ORM/data layer (repositories for `ideas`, `tasks`, `task_runs`).
- [x] `TODO(codex-autonomy-step-02)`: Capture Froussard webhook payloads in `ideas` when Facteur handles GitHub events.
- [x] `TODO(codex-autonomy-step-03)`: Persist task lifecycle updates (`tasks`, `task_runs`, `run_events`) inside the orchestrator code paths.
- [x] Routing consolidation: implementation is orchestrator-only; Knative service is cluster-local with Tailscale exposure (legacy direct dispatch removed).

## Phase 2 – Reflection Memory & Retrieval

- [ ] `TODO(codex-autonomy-step-04)`: Store agent reflections and register them with the vector index.
- [ ] `TODO(codex-autonomy-step-05)`: Fetch top-N reflections during implementation and inject into prompts.

## Phase 3 – Router Feedback & Faithfulness Loop

- [ ] `TODO(codex-autonomy-step-06)`: Log retrieval router decisions to `policy_checks` and `run_events`.
- [ ] `TODO(codex-autonomy-step-07)`: Assemble SSFO preference pairs from artifacts and trigger nightly fine-tune jobs.

## Phase 4 – Domain Adaptation & Monitoring

- [ ] `TODO(codex-autonomy-step-08)`: Manage REFINE-based embedding refresh (track versions, rebuild index on demand).
- [ ] `TODO(codex-autonomy-step-09)`: Incorporate synthetic anomaly generation results into policy checks and metrics.

## Phase 5 – Dashboards & Guardrails

- [ ] `TODO(codex-autonomy-step-10)`: Publish run metrics (latency, success rate) to observability sinks and surface KB health dashboards.
- [ ] `TODO(codex-autonomy-step-11)`: Enforce promotion gates (faithfulness delta ≥ 0, retrieval improvements tracked) before deploying model updates.

## Notes

- Stages build on the schema defined in `services/facteur/migrations/000001_init_codex_kb.sql` and the knowledge base design in `docs/facteur-autonomous-knowledge-base.md`.
- Keep commits scoped to one or two TODO markers to simplify reviews and minimise merge conflicts.

## Rollout Checklist

- Ship Issue #1635 (knowledge store persistence) before enabling the implementation orchestrator in production; the store path currently fails fast while the methods are stubbed.
- Replay an implementation payload via the `protoc`/`curl` recipe in `docs/codex-workflow.md`, and confirm the OTEL spans (`facteur.server.codex_tasks`, `facteur.orchestrator.implement`) record the run metadata.
- Keep the Argo fallback ready by referencing `components/codex-implementation-argo-fallback/` only when you intentionally hand dispatch back to the sensor.
- Run `scripts/argo-lint.sh argocd` and `go test ./services/facteur/...` before promoting changes so Argo CD and CI remain green after the switch.
