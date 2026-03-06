# Torghut Market-Context Batch Migration Follow-Ups (Remaining)

## Scope
This document captures the remaining production work after completing items `1`, `2`, and `4`:

1. Removed dead legacy on-demand dispatch submission code from Jangar market-context runtime.
2. Added strict batch `items[]` validation in finalize/ingest path.
3. Added a route-level integration test for batch finalize execution.
4. Removed legacy `torghut_market_context_dispatch_state` writes from ingest/finalize runtime paths.

## Deferred Items

### 3. Retire legacy single-symbol agent specs after stabilization window
Goal: remove rollback-only spec drift once batch schedules prove stable for at least one full open session.

Implementation notes:
1. Remove single-symbol `ImplementationSpec` manifests from `argocd/applications/agents/torghut-agentruns.yaml`.
2. Keep only `torghut-market-context-fundamentals-batch-v1` and `torghut-market-context-news-batch-v1`.
3. Update runbooks to reference batch specs only.

Acceptance criteria:
1. No active Schedule or AgentRun points at legacy per-symbol specs.
2. Argo CD app sync succeeds with no orphaned spec references.

### 5. Finalize dispatch-state retirement (schema cleanup)
Goal: complete cleanup after runtime write-path removal.

Implementation notes:
1. Remove dispatch-state fields from DB types and related tests.
2. Add migration to drop `torghut_market_context_dispatch_state` once no readers remain.

Acceptance criteria:
1. No runtime write path references `torghut_market_context_dispatch_state`.
2. Migration rollback path is documented before dropping table.

### 6. Explicitly harden trading isolation controls
Goal: ensure market-context jobs cannot impact live execution latency or availability.

Implementation notes:
1. Apply strict CPU/memory requests and limits to batch AgentRun templates.
2. Keep/verify `PriorityClass` placement so trading services retain higher scheduling priority.
3. Add operational guardrail that market-context internal errors always fail open for trading path.

Acceptance criteria:
1. No measurable increase in Torghut execution-path p95 latency during batch windows.
2. Batch overload does not block decision/execution pods from scheduling.

### 7. Complete SLO-driven observability and alerting
Goal: promote current metrics into enforceable freshness/reliability SLO alerts.

Implementation notes:
1. Add alert rules for missing fundamentals session refresh and news freshness breaches (>2h during open market).
2. Add alert thresholds for batch partial/failure rate and sustained symbol-level lag.
3. Publish a short runbook with triage steps and rollback commands.

Acceptance criteria:
1. Alerts fire in staging under forced failure scenarios.
2. On-call playbook includes clear triage, mitigation, and rollback actions.
