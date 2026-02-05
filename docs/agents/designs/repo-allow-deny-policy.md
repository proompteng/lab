# Repository Allow and Deny Policy

Status: Current (2026-02-05)

## Purpose
Constrain repository access for VCS operations using allow and deny lists on VersionControlProvider resources.

## Current State

- Policy is implemented in `services/jangar/src/server/agents-controller.ts` during VCS resolution.
- `VersionControlProvider.spec.repositoryPolicy.allow` and `.deny` accept wildcard patterns (`*`).
- Repositories are normalized to lowercase before matching; patterns should be lowercase for consistent matches.
- Cluster: no `VersionControlProvider` resources are currently present, so repository policy enforcement is not
  active. `argocd/applications/agents/codex-versioncontrolprovider.yaml` defines an allowlist for
  `proompteng/lab`, but the resource is not applied in the cluster.

## Behavior

- If a repo matches `deny`, the run is rejected.
- If `allow` is non-empty and the repo does not match any entry, the run is rejected.
- If `vcsPolicy.mode` is `none`, the controller skips VCS resolution and records a skipped status.

## Configuration Example
```
repositoryPolicy:
  allow:
    - proompteng/lab
  deny:
    - proompteng/private-* 
```

## Validation

- Apply a `VersionControlProvider` with an allowlist and confirm non-allowlisted repos are rejected.
- Add a deny rule and confirm runs are rejected even if allowlisted.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.
