# PR Rate Limits and Batching

Status: Partial (2026-02-05)

## Purpose
Respect VCS provider rate limits by throttling automated PR creation.

## Current State

- Chart config: `controller.vcsProviders.prRateLimits` is rendered to
  `JANGAR_AGENTS_CONTROLLER_VCS_PR_RATE_LIMITS`.
- Controller behavior: `services/jangar/src/server/agents-controller.ts` passes the JSON through to the agent
  runtime as `VCS_PR_RATE_LIMITS`.
- Enforcement: `services/jangar/scripts/codex-implement.ts` enforces rate limits during `gh pr create` using
  a local timestamp file (`/tmp/jangar-pr-rate-limits.json`).
- Cluster: no `prRateLimits` are set in `argocd/applications/agents/values.yaml`.

## Configuration Format
`VCS_PR_RATE_LIMITS` expects a JSON object keyed by provider:
```
{
  "default": { "windowSeconds": 60, "maxRequests": 10, "backoffSeconds": 30 },
  "github": { "windowSeconds": 60, "maxRequests": 5 }
}
```

## Behavior

- The runtime enforces a minimum spacing between PR create calls to smooth bursts.
- Rate-limit state is local to the running pod; it does not coordinate across replicas.

## Gaps

- Jangar itself does not enforce PR rate limits or batching beyond passing config to the runtime.
- Rate limiting is only applied to PR creation paths in the runtime script.

## Validation

- Set `controller.vcsProviders.prRateLimits` and confirm `VCS_PR_RATE_LIMITS` is present in the runtime env.
- Trigger repeated PR creations and confirm the runtime waits between calls.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.
