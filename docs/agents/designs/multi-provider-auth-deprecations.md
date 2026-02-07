# Multi-Provider Auth Standards and Deprecations

Status: Current (2026-02-07)
## Purpose
Normalize auth configuration across VCS providers and surface deprecated token types before they break.

## Current State

- Auth validation lives in `services/jangar/src/server/agents-controller.ts` using provider adapters.
- Supported providers: `github`, `gitlab`, `bitbucket`, `gitea`, `generic`.
- Deprecated token types are tracked per provider and surfaced as `Warning` conditions on both
  `VersionControlProvider` and `AgentRun` resources.
- Chart configuration: `controller.vcsProviders.deprecatedTokenTypes` maps to
  `JANGAR_AGENTS_CONTROLLER_VCS_DEPRECATED_TOKEN_TYPES`.
- Cluster: verify which `VersionControlProvider` resources are applied in your install and whether AgentRuns are
  using them (GitOps commonly declares one under `argocd/applications/agents/*.yaml`).

## Provider Matrix

- GitHub: methods `token`, `app`, `ssh`, `none`; token types `pat`, `fine_grained`, `access_token`.
- GitLab: methods `token`, `ssh`, `none`; token types `pat`, `access_token`.
- Bitbucket: methods `token`, `ssh`, `none`; token types `access_token`.
- Gitea: methods `token`, `ssh`, `none`; token types `api_token`, `access_token`.
- Generic: methods `token`, `ssh`, `none`; token types `pat`, `fine_grained`, `api_token`, `access_token`.

## Deprecation Handling

- Deprecated token types are flagged in `DEFAULT_VCS_AUTH_ADAPTERS` and can be overridden via
  `JANGAR_AGENTS_CONTROLLER_VCS_DEPRECATED_TOKEN_TYPES`.
- Warnings do not block reconciliation but are added to status conditions:
  - `VersionControlProvider.status.conditions[type=Warning]`
  - `AgentRun.status.conditions[type=Warning]`

## Validation Rules

- Unsupported auth methods or token types result in `InvalidSpec` and block reconciliation.
- Missing secrets or keys result in `Unreachable` or `InvalidSpec` conditions.

## Operational Guidance

- Migrate deprecated token types before enforcing stricter validation.
- Use GitHub App auth when possible to avoid PAT deprecation churn.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.

## Validation

- Exercise the primary flow and confirm expected status, logs, or metrics.
- Confirm no regression in existing workflows, CI checks, or chart rendering.

## Acceptance Criteria

- Misconfigured auth is rejected with clear `InvalidSpec` conditions.
- Deprecated token types emit warnings without blocking runs.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
