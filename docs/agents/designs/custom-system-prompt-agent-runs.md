# Custom System Prompt for Agent Runs

Status: Implemented; Agents-owned runtime updated during the Jangar extraction.

Docs index: [README](../README.md)

## Summary

Agent runs enforce Agent-level system prompts. Prompts are configured on `Agent.spec.defaults` as inline text
or a Secret/ConfigMap reference, applied by the Agents controller and Codex app-server runner, and recorded as a
SHA-256 hash for audit without logging prompt contents.

## Current State

- CRDs include `systemPrompt` / `systemPromptRef` on `AgentRun.spec` and `Agent.spec.defaults`, plus
  `status.systemPromptHash` on `AgentRun`.
- Agents rejects run-level prompt overrides on `AgentRun` and resolves prompts from Agent defaults only.
- Generic controller and runtime code lives in `services/agents/src/server/agents-controller`.
- CRD Go sources live in `services/agents/api/agents/v1alpha1/types.go`; `charts/agents/crds` is generated from
  those sources.
- The Codex runner is the Agents app-server harness in `services/agents/src/runner/codex-app-server.ts` and
  `services/agents/scripts/codex/agent-runner.ts`.
- Helm and GitOps runtime configuration uses `AGENTS_*` env names. Compatibility aliases are read only and must not
  be emitted by the rendered Agents chart.

## API

Optional prompt fields are available on Agent defaults:

```yaml
spec:
  defaults:
    systemPrompt: string
    systemPromptRef:
      kind: Secret|ConfigMap
      name: string
      key: string
```

The fields still exist on `AgentRun.spec` for schema compatibility, but controller policy rejects run-level
overrides. The effective prompt comes from the referenced Agent.

Validation:

- `systemPrompt` max length is 16384.
- `systemPrompt` and `systemPromptRef` are mutually exclusive at each level.
- `systemPromptRef.kind` must be `Secret` or `ConfigMap`.
- Prompt refs must point to objects in the same namespace.
- Inline `systemPrompt` is non-secret; sensitive prompts should use `systemPromptRef`.

## Resolution

1. `Agent.spec.defaults.systemPromptRef`
2. `Agent.spec.defaults.systemPrompt`
3. Fail the run with `MissingSystemPromptConfiguration`

Blank inline strings are treated as unset. A ref takes precedence over inline prompt fields so the controller has one
auditable source of truth for the resolved prompt.

## Controller Behavior

- Rejects `AgentRun.spec.systemPrompt` and `AgentRun.spec.systemPromptRef`.
- Resolves the effective prompt from Agent defaults.
- Inline prompt: included in the normalized runner contract for providers that need pass-through payloads.
- Ref prompt: mounted into the runner pod as `/workspace/.codex/system-prompt.txt`; `CODEX_SYSTEM_PROMPT_PATH` points
  at that file.
- Ref prompt contents are not copied into ConfigMaps, annotations, or logs.
- Records `AgentRun.status.systemPromptHash` as the SHA-256 hex of the resolved prompt.

Security constraints:

- Secret refs must be listed in `AgentRun.spec.secrets`.
- If `Agent.spec.security.allowedSecrets` is non-empty, Secret refs must be allowlisted there.
- Secret refs must not match `AGENTS_CONTROLLER_BLOCKED_SECRETS`.
- ConfigMap refs do not require secret allowlisting.
- Missing refs, missing keys, invalid refs, or policy failures mark the run invalid.

## Runtime Behavior

The Agents controller writes the runner contract as `run.json` and `agent-runner.json`.

For `adapter.type: codex-app-server`, the runner:

- Reads prompt inputs, goal, model, effort, sandbox, approval policy, cwd, thread config, and system prompt from the
  normalized contract.
- Prefers `CODEX_SYSTEM_PROMPT_PATH` when a prompt ref is mounted; otherwise uses the inline resolved prompt in the
  contract.
- Passes the resolved system prompt to the Codex app-server turn as developer/base instructions through
  `CodexAppServerClient.runTurnStream`.
- Streams app-server events to the runner log and writes deterministic status and artifact outputs under the Agents
  runner workspace.
- Logs prompt hash and length only; prompt contents are not emitted.

Legacy `adapter.type: exec` providers can still receive the prompt through the normalized contract during the
transition, but generic Codex providers should use the app-server adapter.

## Data Flow: Inline Prompt

1. Agent default is configured with `spec.defaults.systemPrompt`.
2. Agents resolves and validates the prompt.
3. Agents records `AgentRun.status.systemPromptHash`.
4. Agents writes `run.json` and `agent-runner.json` for the runner.
5. The Codex app-server runner passes the prompt into the app-server turn and streams events/logs/status through the
   Agents runner contract.

## Data Flow: Ref Prompt

1. Agent default is configured with `spec.defaults.systemPromptRef`.
2. Agents validates secret/configmap policy and resolves the referenced object.
3. Agents mounts the Secret/ConfigMap into the runner pod and sets `CODEX_SYSTEM_PROMPT_PATH`.
4. Agents records `AgentRun.status.systemPromptHash`.
5. The Codex app-server runner reads the mounted prompt file, passes it into the app-server turn, and keeps prompt
   contents out of payloads and logs.

## Hashing and Audit

- `AgentRun.status.systemPromptHash` stores the SHA-256 hex of the resolved prompt.
- Runtime logs may include the hash and prompt length, never the content.
- If a Secret/ConfigMap changes after controller resolution, the mounted content for a new pod reflects Kubernetes
  projection behavior; acceptance tests should compare the status hash to the mounted file used by the runner.

## Source of Truth

- Helm chart and CRDs: `charts/agents`
- GitOps application: `argocd/applications/agents`
- CRD Go types and codegen: `services/agents/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controller runtime: `services/agents/src/server/agents-controller`
- Codex app-server runner: `services/agents/src/runner/codex-app-server.ts`,
  `services/agents/scripts/codex/agent-runner.ts`
- Codex app-server client: `packages/codex/src/app-server-client.ts`

## Validation

Run these before changing prompt schema or runtime behavior:

```bash
scripts/agents/validate-agents.sh
bun run --filter @proompteng/agents test
bun run --filter @proompteng/agents tsc
bash scripts/agents/guard-extraction-boundaries.sh
mise exec helm@3 -- helm lint charts/agents
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.yaml
```

Live acceptance:

- Rendered Agents manifests use `AGENTS_*` env names and Agents-owned images.
- The live `agentproviders.agents.proompteng.ai` CRD accepts `spec.secretEnv` and `spec.adapter`.
- A Codex app-server `AgentRun` succeeds and its generated `run.json` and `agent-runner.json` contain the resolved
  goal and normalized adapter.
- The AgentRun status contains `systemPromptHash`, and runner logs do not contain prompt contents.

## Limitations

- No per-workflow-step system prompt overrides; workflow steps share the resolved Agent default prompt.
- Non-Codex providers receive prompt data only through the normalized runner contract and decide whether to consume it.
