# Production-Grade Design Requirements (Agents Platform)

Status: Current (2026-01-19)

## API & Contracts
- Full CRD schemas for all resources (spec + status) with defaults and validation rules.
- Explicit size limits for large fields (e.g., ImplementationSpec text).
- Conversion strategy when moving beyond v1alpha1 (webhook design + deprecation policy).
- Runtime adapter contract: submit/status/cancel inputs and error codes.
- Agent-runner spec contract: required fields, workspace layout, artifact paths.
- Control-plane status endpoint (gRPC + `/api/agents/control-plane/status`) for controller/runtime/database health.
- gRPC is optional in production (agentctl works via Kubernetes API; gRPC is additive).

## Reliability & Scaling
- SLOs: availability, submission latency, reconcile delay, failure rate.
- Concurrency controls per AgentRun and per namespace.
- Backoff/retry policy for each reconciler (AgentRun, ImplementationSource, Memory).
- Idempotency keys for run submission to avoid duplicates.
- Controller leader election and horizontal scaling strategy.

## Security & Compliance
- Threat model and trust boundaries (cluster, integrations, runtime, secrets).
- RBAC matrix with least-privilege roles.
- Secret lifecycle and rotation policy.
- Supply-chain: signed images, SBOMs, provenance attestations.
- Audit logging for run submissions and integration events.

## Data & Storage
- State ownership: what is stored in CRDs vs external stores.
- Memory backend health checks and failure behavior.
- Retention policy for runs, artifacts, and logs.
- Disaster recovery plan for external memory backends.

## Observability
- Metrics spec (names, labels, units).
- Tracing/correlation IDs across Jangar, runtime adapter, and agent-runner.
- Standard dashboards and alert thresholds.
- Kubernetes Events for submit/start/finish/failure.

## Testing & Validation
- CRD example validation in CI.
- E2E tests against kind/minikube.
- Integration tests for GitHub + Linear sync.
- Load/perf tests (run throughput, reconciler lag).

## Operations & Runbooks
- Install/upgrade/rollback procedures.
- Common incident runbooks (stuck runs, failed sync, memory outage).
- Debug procedures and diagnostics (`agentctl diagnose`).

## Product UX
- CLI UX spec for error output and partial failures.
- Guided quickstart and “first run in 5 minutes” flow.
- Migration guides for schema changes.

## Publication & Governance
- Release cadence and changelog policy.
- Public roadmap and issue labeling.
- Contributor guidelines and code of conduct.

## Decisions (Concrete Defaults)
- SLOs: 99.5% controller availability monthly; 95th percentile run submit < 2s; 95th percentile reconcile delay < 10s.
- Concurrency defaults: 10 in-flight AgentRuns per namespace, 5 per Agent, 100 cluster-wide.
- Retry/backoff: exponential with base 5s, max 5m, jitter 20%.
- Retention: AgentRun records 30 days; logs/artifacts 7 days (runtime configurable).
- Size limits: ImplementationSpec text 128KB; parameters max 100 entries, 2KB per value.
- Supply chain: images signed (cosign), SBOMs (SPDX) published per release.
- Release cadence: monthly minor, patch releases as needed for security fixes.
