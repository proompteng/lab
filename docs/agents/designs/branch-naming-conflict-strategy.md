# Branch Naming and Conflict Strategy

Status: Current (2026-02-05)

## Purpose
Provide deterministic branch naming for automated PRs and avoid conflicts when multiple runs target the same repo.

## Current State

- `VersionControlProvider.spec.defaults.branchTemplate` and `branchConflictSuffixTemplate` are supported.
- Template rendering uses `{{ path.to.value }}` with a simple dot-path resolver in
  `services/jangar/src/server/agents-controller.ts`.
- Branch conflicts are detected against active AgentRuns in the same namespace with matching repository and branch.
- Cluster: no `VersionControlProvider` resources are currently present, so defaults are not applied.

## Template Context
The following context is available to templates:
- `parameters`: AgentRun parameters.
- `metadata`: AgentRun metadata.
- `agentRun.name` and `agentRun.namespace`.
- `event`: webhook payload for implementation sources when available.

## Conflict Resolution

- When an active run uses the same repository and head branch, the controller renders
  `branchConflictSuffixTemplate` and appends it to the branch.
- Suffixes are normalized to avoid duplicate separators.

## Configuration Example
```
defaults:
  baseBranch: main
  branchTemplate: codex/{{issueNumber}}
  branchConflictSuffixTemplate: "{{agentRun.name}}"
```

## Validation

- Submit two runs with the same `branchTemplate` and confirm the second run uses a suffixed branch.
- Confirm branches normalize correctly when the suffix begins with `/` or `-`.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.
