# CI Validation Plan (Agents)

Status: Draft (2026-01-13)

## CRD Validation
- Generate CRDs from Go types and verify:
  - Structural schema
  - JSON size <= 256KB
  - `subresources.status` present
- Validate CRD examples against schemas.

## Helm Validation
- `helm lint charts/agents`
- `helm template charts/agents` with dev/prod values
- Check rendered manifests for disallowed resources (ingress, embedded DB).

## Integration Tests
- kind/minikube smoke test:
  - Install chart
  - Apply Agent/ImplementationSpec/AgentRun
  - Verify AgentRun completion and status
- GitHub + Linear mock sync tests (webhook or poll).

## Performance
- Load test AgentRun submission (concurrency limits enforced).
- Measure reconcile latency p95.

## Security
- SBOM generation and vulnerability scan.
- Image signature verification checks.
