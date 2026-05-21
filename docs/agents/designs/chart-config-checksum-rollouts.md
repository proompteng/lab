# Chart Config Checksum Rollouts

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Overview

Kubernetes does not automatically restart pods when referenced Secrets/ConfigMaps change (especially when referenced via env vars). In GitOps environments, this frequently leads to stale runtime config with active Pods still using old values.

This doc defines the checksum annotation mechanism used to trigger Deployment rollouts when selected config inputs change.

## Goals

- Provide an opt-in mechanism to restart control plane/controllers when key Secrets/ConfigMaps change.
- Make the behavior explicit and easy to validate in Helm renders.

## Non-Goals

- Automatically restarting on all Secrets/ConfigMaps in the namespace.

## Current State

- Chart references:
- DB URL Secret: `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml`
- `envFromSecretRefs` / `envFromConfigMapRefs`: same templates
- `database.caSecret`: same templates (volume + `PGSSLROOTCERT`)
- `agentComms.nats.userSecret`: same templates (NATS credentials)
- Checksum annotations exist in both control plane and controllers pod templates.

## Design

The chart supports two ownership modes:

- Chart-owned DB URL secret source (`database.createSecret.enabled=true`) with automatic checksum derivation from
  the Helm value.
- GitOps/external secret/configmap sources with explicit checksum values supplied by operators.

### Proposed values

- `rolloutChecksums.enabled` (default `false`)
- `rolloutChecksums.secrets: []`
- `rolloutChecksums.configMaps: []`

Each checksum entry is an object:

```yaml
- name: <secret-or-configmap-name>
  namespace: <optional-namespace> # defaults to release namespace
  checksum: <sha256 value>
```

For chart-owned inputs (`database.createSecret.enabled=true`), checksum values are computed from
`.Values.database.url` and merged automatically.

All manually provided checksums must be SHA-256 hex values (64 characters). `namespace`
and `name` values must match Kubernetes DNS-1123 syntax, and `namespace/name` pairs are
deduplicated within each list.

When enabled, annotate pod templates with:

- `agents.proompteng.ai/checksum-secret-<hash>: <sha256>`
- `agents.proompteng.ai/checksum-configmap-<hash>: <sha256>`

Where `<hash>` is a deterministic SHA-256-derived suffix from the referenced object identity
(`kind`, `namespace`, `name`). This keeps annotation names within Kubernetes key length limits.

### Source of truth

- Runtime implementation in chart templates:
  - `charts/agents/templates/deployment.yaml`
  - `charts/agents/templates/deployment-controllers.yaml`
  - `charts/agents/templates/_helpers.tpl`
- Values + schema:
  - `charts/agents/values.yaml`
  - `charts/agents/values.schema.json`
- Validation hook:
  - `charts/agents/templates/validation.yaml`

### Source-of-truth and ownership model

- `database.createSecret.enabled=true`: source of truth is chart values (`database.url`). This
  checksum is automatically generated and owned by the chart.
- Externally managed resources: source of truth is the GitOps/Secrets controller manifest and any
  backing data store. The chart does not perform live lookups of Secret/ConfigMap payloads.

The explicit checksum list is therefore your contract boundary for restart behavior. The chart validation
phase enforces contract completeness, so enabling `rolloutChecksums.enabled` requires explicit entries
for every externally-managed Secret/ConfigMap input present in the rendered pod templates.

For GitOps-managed objects (ESO/External Secrets, sealed-secrets, or similar), this means:

- the manifest generator is the source of truth, not Helm rendering;
- the checksum values must be computed from the external source payload and copied into Helm values;
- omitted resources will not trigger rollouts when changed.

Relevant chart inputs to include when externally managed:

- `database.createSecret` (chart-owned value-derived secret)
- `database.secretRef`
- `database.caSecret`
- `envFromSecretRefs`
- `envFromConfigMapRefs`
- `env.secrets`
- `env.config`
- `agentComms.nats.userSecret`

### Operator usage

1. Enable rollout checksums:

```yaml
rolloutChecksums:
  enabled: true
```

2. For chart-owned DB secret input (`database.createSecret.enabled=true`), chart calculates checksum from `database.url` automatically.

3. For externally managed inputs, add explicit checksum entries:

```yaml
rolloutChecksums:
  enabled: true
  secrets:
    - name: agents-github-token-env
      checksum: 9f2c... # sha256 of the external payload, 64 hex chars
      namespace: agents
  configMaps:
    - name: agents-runtime-config
      checksum: 4a1b... # sha256 of the external payload, 64 hex chars
      namespace: agents
```

For reliable hashes, include the payload bytes that the workload consumes (for example, both
`data` and `binaryData` for Secrets/ConfigMaps), and sort keys before hashing (`jq -cS`) so
identical logical values produce stable hashes.

For externally managed resources, compute hashes from source-of-truth manifests (for example, ExternalSecret/SealedSecret templates) and use that value in
`rolloutChecksums` to ensure deterministic rollouts.

## Config Mapping

| Helm value                                                                               | Rendered annotation                                           | Intended behavior                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `rolloutChecksums.enabled=true`                                                          | `agents.proompteng.ai/checksum-*` annotations                 | Any change triggers a Deployment rollout.            |
| `rolloutChecksums.secrets=[{\"name\":\"agents-github-token-env\",\"checksum\":\"...\"}]` | `agents.proompteng.ai/checksum-secret-<hash(namespace/name)>` | Restart when the referenced Secret checksum changes. |

## Rollout Plan

1. Add feature behind `rolloutChecksums.enabled=false`.
2. Enable in non-prod with one Secret (e.g. GitHub token) to validate.
3. Enable in prod after validating rollout behavior and avoiding excessive restarts.

Rollback:

- Disable the flag; annotation removal stops checksum-triggered rollouts.

## Validation

```bash
helm template charts/agents \
  --set rolloutChecksums.enabled=true \
  --set rolloutChecksums.secrets[0].name=agents-github-token-env \
  --set-string rolloutChecksums.secrets[0].checksum=9f2c... \
  --set rolloutChecksums.configMaps[0].name=agents-runtime-config \
  --set-string rolloutChecksums.configMaps[0].checksum=a1b2c3... |
  rg -n "agents\\.proompteng\\.ai/checksum-(secret|configmap)-"
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.metadata.annotations}'; echo
```

Example checksum capture from a live ConfigMap/Secret payload:

```bash
kubectl -n agents get configmap agents-runtime-config -o json |
  jq -cS '{data: .data, binaryData: .binaryData}' |
  sha256sum | awk '{print $1}'

kubectl -n agents get secret agents-github-token-env -o json |
  jq -cS '{data: .data, binaryData: .binaryData}' |
  sha256sum | awk '{print $1}'
```

If you only consume specific keys, use a stable projection that mirrors runtime usage:

```bash
kubectl -n agents get configmap agents-runtime-config -o json |
  jq -cS '{data: {WORKLOAD_TIMEOUT: .data.WORKLOAD_TIMEOUT}}' |
  sha256sum | awk '{print $1}'
```

### External manager limitations

- The chart validates input shape and checksum format but does not inspect live cluster objects at render time.
- Every externally managed Secret/ConfigMap affecting container behavior must be included in this list.
- Changing any listed value without updating the corresponding checksum entry will keep the existing pod template
  unchanged after GitOps reconcile.

## Failure Modes and Mitigations

- Too many checksum sources cause frequent rollouts: mitigate with explicit allowlist and opt-in.
- Checksum cannot be safely computed for external resources at render time: mitigate by adding explicit checksum entries.

## Acceptance Criteria

- Enabling the feature causes a deterministic rollout on config changes.
- Operators can scope restarts to a small list of critical Secrets/ConfigMaps.

## References

- Kubernetes ConfigMaps/Secrets update behavior: https://kubernetes.io/docs/concepts/configuration/configmap/
