# CRD YAML Spec (Agents)

Status: Current (2026-01-19)

Docs index: [README](README.md)

## Required CRDs

- Agent
- AgentRun
- AgentProvider
- ImplementationSpec
- ImplementationSource
- Memory

## Common Requirements (all CRDs)

- `apiVersion: apiextensions.k8s.io/v1`
- `spec.versions[*].schema.openAPIV3Schema` present
- `spec.versions[*].subresources.status` enabled
- `spec.versions[*].additionalPrinterColumns` present where useful
- `spec.versions[*].schema.openAPIV3Schema.properties.status.properties.observedGeneration` included
- Do not set `x-kubernetes-preserve-unknown-fields: false` on the root schema. Omit the field and
  rely on structural schemas, marking only explicit subtrees as schemaless.
- Mark only specific subtrees as schemaless via:
  - `x-kubernetes-preserve-unknown-fields: true` or
  - `additionalProperties: { type: string }` (for string maps)

## Schemaless Subtrees

- Agent:
  - `spec.config` (map)
- AgentRun:
  - `spec.runtime.config` (map)
  - `spec.parameters` (map)
  - `spec.goal` is structured, not schemaless.
- ImplementationSpec:
  - no schemaless fields (plain strings only)

## Printer Columns (minimum)

### AgentRun

- Succeeded: `.status.conditions[?(@.type=="Succeeded")].status`
- Reason: `.status.conditions[?(@.type=="Succeeded")].reason`
- StartTime: `.status.startedAt`
- CompletionTime: `.status.finishedAt`
- Runtime: `.spec.runtime.type`

### ImplementationSpec

- Ready: `.status.conditions[?(@.type=="Ready")].status`
- Source: `.spec.source.provider`
- Updated: `.status.syncedAt`

## Versioning

- v1alpha1 only (no conversion webhook yet).
- When v1beta1 arrives: add conversion webhook and freeze v1alpha1 fields.

## Size Budget

- Validate generated CRD JSON <= 256KB (Tekton practice).
- Strip descriptions if necessary.

## Validation Rules (minimum)

- Required fields:
  - Agent: `spec.providerRef.name`
  - AgentRun: `spec.agentRef.name`, `spec.runtime.type`, `spec.implementationSpecRef.name` OR `spec.implementation.inline`
  - AgentProvider: `spec.binary`
  - ImplementationSpec: `spec.text`
  - ImplementationSource: `spec.provider`, `spec.auth.secretRef`, `spec.webhook.enabled=true`
  - Memory: `spec.type`, `spec.connection.secretRef`
- Optional fields:
  - AgentRun: `spec.ttlSecondsAfterFinished` (integer seconds, >= 0) to override controller retention (0 disables).
  - AgentRun: `spec.goal.objective` (string) and optional `spec.goal.tokenBudget` (integer, >= 1) to expose a
    first-class Codex goal in generated run payloads.
  - Agent: `spec.security.allowedImplementationSourceProviders[]` restricts inline and referenced
    implementation provenance providers.
  - AgentProvider: `spec.workload.serviceAccountName` supplies the provider workload identity.
  - AgentProvider: `spec.workload.serviceAccountToken` configures a projected token with required
    `audience`, 600-3600 second `expirationSeconds`, and absolute `mountPath`.

The effective runtime service account is resolved consistently for Jobs and Workflows and, when the
allowlist is configured, must be present in `Agent.spec.security.allowedServiceAccounts`. When a projected provider token is used,
the default Kubernetes API token is disabled and only that rotating audience-bound token is mounted.

## Status Conditions (standard)

- All CRDs include `status.conditions[]` with `type`, `status`, `reason`, `message`, `lastTransitionTime`.

## Diagram

```mermaid
flowchart LR
  Types["Go types / static YAML"] --> Gen["controller-gen (when applicable)"]
  Gen --> CRD["CRDs in charts/agents/crds"]
  CRD --> Helm["Helm installs CRDs"]
  Helm --> API["Kubernetes API server"]
```
