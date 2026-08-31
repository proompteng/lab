# Agent Primitive

## Purpose and ownership

The `Agent` primitive is a reusable, namespaced worker profile. It points at an `AgentProvider` and can supply
configuration, environment, security allowlists, memory/VCS references, and run defaults. An `AgentRun` is the
namespaced execution record that selects an implementation and runtime for one invocation.

The Agents service owns the `Agent`, `AgentRun`, `AgentProvider`, and `ImplementationSpec` resources and their
controller/runner lifecycle. Jangar can call the Agents `/v1` API, but it does not own these generic CRDs or their
controller. Provider-specific configuration belongs in `AgentProvider`; it is not invented under `Agent.spec.inputs`,
`Agent.spec.payloads`, or `AgentRun.spec.deliveryId`.

## Current source of truth

- Go API types: `services/agents/api/agents/v1alpha1/types.go`
- Generated CRDs: `charts/agents/crds/agents.proompteng.ai_agents.yaml`,
  `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`, and
  `charts/agents/crds/agents.proompteng.ai_agentproviders.yaml`
- Chart examples: `charts/agents/examples/agent-sample.yaml`,
  `charts/agents/examples/agentrun-sample.yaml`, and `charts/agents/examples/agentprovider-sample.yaml`
- Controller: `services/agents/src/server/agents-controller`
- Runner: `services/agents/scripts/codex/agent-runner.ts`

## `Agent`

`Agent` is namespaced. `spec.providerRef.name` is required and resolves an `AgentProvider` in the same namespace.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: Agent
metadata:
  name: codex-agent
  namespace: agents
spec:
  providerRef:
    name: codex-runner
  memoryRef:
    name: default-memory
  config:
    model: gpt-5.6-sol
  env:
    - name: CODEX_MODE
      value: autonomous
  defaults:
    timeoutSeconds: 3600
    retryLimit: 1
```

`Agent.spec` contains:

- required `providerRef: {name}`;
- optional schemaless `config` values;
- optional `env[]` entries with required `name` and `value`;
- optional `security` allowlists: `allowedServiceAccounts`, `allowedSecrets`, and
  `allowedImplementationSourceProviders`;
- optional same-namespace `memoryRef: {name}` and `vcsRef: {name}`;
- optional `defaults`, containing non-negative `timeoutSeconds` and `retryLimit`, plus either `systemPrompt` or
  `systemPromptRef` (`kind` is `Secret` or `ConfigMap`, with `name` and `key`).

The two default system-prompt fields are mutually exclusive. `Agent.status` has no phase; it contains optional
`conditions`, `updatedAt`, and `observedGeneration`. The controller uses conditions to report provider and memory
reference problems.

## `AgentRun`

`AgentRun` is namespaced and requires `agentRef`, `runtime`, and exactly one implementation source:
`implementationSpecRef: {name}` or `implementation.inline`. The following shows the complete run shape and uses an
inline implementation; it assumes the referenced `codex-agent` and `default-memory` resources exist.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: codex-run-sample
  namespace: agents
spec:
  agentRef:
    name: codex-agent
  implementation:
    inline:
      text: 'Run the requested implementation task and report the result.'
      summary: 'Example inline AgentRun implementation'
  memoryRef:
    name: default-memory
  runtime:
    type: job
  workload:
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/example-run
  idempotencyKey: example-run-001
  ttlSecondsAfterFinished: 600
```

### `AgentRun.spec` fields

| Field                                             | Current contract                                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentRef`                                        | Required same-namespace `{name}` reference.                                                                                                                                                                                            |
| `implementationSpecRef` / `implementation.inline` | One is required. The inline form contains current `ImplementationSpecFields`, including required `text` and optional `source`, `vcsRef`, `summary`, `description`, `acceptanceCriteria`, `labels`, and `contract`.                     |
| `goal`                                            | Optional `{objective, tokenBudget}`; `objective` is required within `goal` and `tokenBudget` is at least 1 when present.                                                                                                               |
| `runtime`                                         | Required. `type` is `workflow`, `job`, `temporal`, or `custom`; `config` is a preserved provider/runtime-specific map.                                                                                                                 |
| `workflow`                                        | Optional `steps[]`; each step has `name`, optional implementation ref/inline implementation, string `parameters`, optional `workload`, `retries`, `retryBackoffSeconds`, `timeoutSeconds`, and `loop`.                                 |
| `workload`                                        | Optional `image`, `resources.requests`, `resources.limits`, and `volumes[]`. A volume has `type` (`emptyDir`, `pvc`, or `secret`), `name`, `mountPath`, and optional `readOnly`, `claimName`, `secretName`, `sizeLimit`, and `medium`. |
| `parameters`                                      | Optional map of at most 100 string values. `parameters.prompt` is rejected; put implementation text in `ImplementationSpec.spec.text`.                                                                                                 |
| `secrets`                                         | Optional list of Secret names allowed for the run.                                                                                                                                                                                     |
| `memoryRef`, `vcsRef`                             | Optional same-namespace `{name}` references.                                                                                                                                                                                           |
| `vcsPolicy`                                       | Optional `{required, mode}`; `mode` is `read-write`, `read-only`, or `none`.                                                                                                                                                           |
| `systemPrompt`, `systemPromptRef`                 | Present in the Go type for compatibility but rejected on `AgentRun` by CRD validation and the API. Configure `Agent.spec.defaults` instead.                                                                                            |
| `idempotencyKey`                                  | Optional CRD field used for AgentRun de-duplication. It is distinct from the required HTTP `Idempotency-Key` header.                                                                                                                   |
| `ttlSecondsAfterFinished`                         | Optional non-negative top-level retention value in seconds.                                                                                                                                                                            |

The `runtime.config` map is not a substitute for a removed top-level field. For example, the current CRD has a
top-level `ttlSecondsAfterFinished`; a runtime-specific `config.ttlSecondsAfterFinished` is not the documented TTL
contract.

`AgentRun.status` is also not a `submittedAt`/`artifactKeys` contract. Current fields are:

- `phase`, `reason`, and `message`; the controller uses `Pending`, `Running`, `Succeeded`, `Failed`, and `Cancelled`;
- preserved `runtimeRef` and normalized `runner` maps;
- optional `workflow` status with phase and per-step attempt/timestamp/job data;
- `startedAt`, `finishedAt`, and `updatedAt`;
- `artifacts[]` entries (`name`, optional `path`, `key`, and `url`);
- optional `vcs` status (`provider`, `repository`, `baseBranch`, `headBranch`, `mode`);
- `systemPromptHash`, `specHash`, `conditions`, `observedGeneration`, and `contract` (`requiredKeys`, `missingKeys`).

## `AgentProvider`

`AgentProvider` is also namespaced. It is not a cluster-scoped composite and must not be treated as a global object;
an `Agent` resolves its provider by same-namespace name.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentProvider
metadata:
  name: codex-runner
  namespace: agents
spec:
  binary: /usr/local/bin/agent-runner
  adapter:
    type: codex-app-server
  argsTemplate: []
  envTemplate:
    CODEX_LOG_LEVEL: info
  inputFiles:
    - path: /workspace/implementation.txt
      content: '{{implementation.text}}'
  outputArtifacts:
    - name: agent-log
      path: /workspace/agent.log
```

`spec.binary` is required. The other current fields are `argsTemplate[]`, string-valued `envTemplate`, `secretEnv[]`
(`name`, `secretName`, `key`, `optional`), `inputFiles[]` (`path`, `content`), `outputArtifacts[]` (`name`, optional
`path`, `key`, `url`), optional `health.capacityFailurePolicy` (`degrade` or `block`), optional provider-owned
`workload` defaults (`image`, `resources.requests`, `resources.limits`, `serviceAccountName`, and
`serviceAccountToken`). A service-account token has required `audience`, `expirationSeconds` (600–3600), and an
absolute `mountPath`. The remaining field is a preserved `adapter` map. The chart sample's `codex-app-server` adapter
is current; arbitrary adapter keys are not a license to invent CRD fields.

## Runner and runtime boundary

The chart's current Codex provider uses `/usr/local/bin/agent-runner` as its `spec.binary`. The runner accepts a JSON
spec from a file argument, `AGENT_RUNNER_SPEC_PATH`, or `AGENT_RUNNER_SPEC`, renders the provider templates, and runs
the selected adapter. This is the current runner contract; it is not a universal requirement that every runtime image
contain that path or a `/usr/local/bin/codex` binary. A custom provider's `binary` must exist in the selected workload
image.

The controller accepts `job`, `workflow`, `temporal`, and `custom` runtime types. Job and native workflow execution
use Kubernetes Jobs; Temporal and custom types use their respective adapter paths. Do not describe every runtime as
the native Job/runner path.

## Agents API boundary

Current Agents routes include:

- `POST /v1/agents` and `GET /v1/agents/$id`;
- `POST /v1/agent-runs`, `GET /v1/agent-runs`, and `GET /v1/agent-runs/$id`;
- `GET /v1/runs/$id` for the common run reader.

The `POST /v1/agent-runs` handler requires the `Idempotency-Key` HTTP header. Its JSON payload may provide an
`idempotencyKey`; the server maps that value to `AgentRun.spec.idempotencyKey` and falls back to the header when the
payload omits it. Neither the API nor the CRD has a `deliveryId` field for AgentRun.

## Security and observability

Secret access is controlled by the `Agent.spec.security` allowlists and run references. Runtime status carries
conditions, hashes, VCS information, runner metadata, and artifact records; callers should inspect those fields rather
than relying on the retired `submittedAt` or `artifactKeys` names.
