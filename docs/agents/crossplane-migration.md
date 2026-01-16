# Crossplane → Native Agents CRDs Migration

Status: Draft (2026-01-16)

Crossplane-based Agents XRDs (`XAgent`, `XAgentRun`, `XAgentProvider`) conflict with the native
`agents.proompteng.ai/v1alpha1` CRDs installed by `charts/agents`. This guide describes how to
retire the Crossplane package safely and move existing claims to the native CRDs.

## Order of operations (required)
1. **Export existing Crossplane claims**
   ```bash
   kubectl get agents.agents.proompteng.ai -A -o yaml > /tmp/xplane-agents.yaml
   kubectl get agentruns.agents.proompteng.ai -A -o yaml > /tmp/xplane-agentruns.yaml
   kubectl get agentproviders.agents.proompteng.ai -A -o yaml > /tmp/xplane-agentproviders.yaml
   ```
2. **Convert manifests to native CRDs** using the mapping tables below.
3. **Remove Crossplane Agents package and XRDs** (stop reconcile to avoid conflicts):
   ```bash
   # Remove GitOps references to packages/crossplane/deprecated/configuration-agents first.
   kubectl delete configurations.pkg.crossplane.io configuration-agents
   kubectl delete xrd xagents.agents.proompteng.ai xagentruns.agents.proompteng.ai xagentproviders.agents.proompteng.ai
   ```
4. **Install the native chart**:
   ```bash
   helm upgrade --install agents charts/agents -n agents --create-namespace
   ```
5. **Apply converted native manifests**:
   ```bash
   kubectl apply -f /tmp/native-agents.yaml
   kubectl apply -f /tmp/native-agentproviders.yaml
   kubectl apply -f /tmp/native-agentruns.yaml
   ```
6. **Validate**:
   - `kubectl get agents.agents.proompteng.ai -A`
   - `kubectl get agentruns.agents.proompteng.ai -A`
   - Check status conditions on each resource

## Export + convert tips
- Use `kubectl get ... -o yaml` exports as the source of truth for conversion.
- Strip Crossplane-specific metadata (`spec.writeConnectionSecretToRef`, `compositionRef`, etc).
- Keep names/namespaces stable so references continue to resolve.
- Convert labels/annotations that your workflows rely on.

## Mapping: XAgent → Agent
| Crossplane field | Native field | Notes |
| --- | --- | --- |
| `spec.providerRef.name` | `spec.providerRef.name` | Same reference. |
| `spec.env[]` | `spec.env[]` | Same structure. |
| `spec.security.allowedServiceAccounts` | `spec.security.allowedServiceAccounts` | Same structure. |
| `spec.security.allowedSecrets` | `spec.security.allowedSecrets` | Same structure. |
| `spec.runtime`, `spec.inputs`, `spec.payloads`, `spec.resources`, `spec.observability` | `spec.config` | Preserve as free-form config if you still need this data; Jangar ignores unknown fields unless your runtime adapter consumes it. |

## Mapping: XAgentProvider → AgentProvider
| Crossplane field | Native field | Notes |
| --- | --- | --- |
| `spec.binary` | `spec.binary` | Required. |
| `spec.argsTemplate` | `spec.argsTemplate` | Same structure. |
| `spec.envTemplate` | `spec.envTemplate` | Same structure. |
| `spec.inputFiles` | `spec.inputFiles` | Same structure. |
| `spec.outputArtifacts` | `spec.outputArtifacts` | Same structure. |

## Mapping: XAgentRun → AgentRun
| Crossplane field | Native field | Notes |
| --- | --- | --- |
| `spec.agentRef.name` | `spec.agentRef.name` | Same reference. |
| `spec.parameters` | `spec.parameters` | Same structure. |
| `spec.timeoutSeconds` | `spec.workload.resources` or `spec.runtime.config` | Map manually depending on runtime adapter. |
| `spec.runtimeOverrides.argo.*` | `spec.runtime.type=argo` + `spec.runtime.config.*` | Populate `workflowTemplate` explicitly. |
| `spec.deliveryId` | `spec.idempotencyKey` | Optional; convert if needed. |

Native AgentRuns require `spec.runtime.type` and (for job runtime) `spec.workload.image` or the
`JANGAR_AGENT_RUNNER_IMAGE` env var on Jangar. Crossplane claims typically delegated runtime
selection to the composition, so you must add these fields explicitly.

## Post-migration validation
- Confirm Jangar reports readiness at `/health` and logs no missing CRD errors.
- Apply `charts/agents/examples/*` and ensure AgentRuns reach `Succeeded`.
- For Argo runtime, verify Workflow creation in the target namespace.

## Rollback
If migration fails, reinstall the Crossplane configuration package and re-apply the original
claims. Do **not** run both native CRDs and Crossplane XRDs simultaneously.
