# Pod Security Admission Labels

Status: Current (2026-02-05)

## Purpose
Allow optional Pod Security Admission (PSA) labels to be applied to the agents namespace during installation.

## Current State

- Chart values: `podSecurityAdmission.enabled`, `podSecurityAdmission.createNamespace`, and
  `podSecurityAdmission.labels`.
- Template: `charts/agents/templates/namespace.yaml` creates a Namespace with PSA labels when enabled.
- Cluster: the `agents` namespace only has the default `kubernetes.io/metadata.name` label; PSA labels are not
  applied.

## Design

- When enabled, render a namespace manifest with PSA labels.
- When disabled, do not mutate existing namespaces.

## Configuration
Example values:
```
podSecurityAdmission:
  enabled: true
  createNamespace: true
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

## Validation

- Enable PSA labels and confirm the namespace is created with the correct labels.
- Disable PSA labels and confirm no namespace changes are applied.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.
