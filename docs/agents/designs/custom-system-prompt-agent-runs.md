# Custom System Prompt for Agent Runs

Status: Draft (2026-02-05)

## Problem
Agent runs cannot set a per-run system prompt. Codex runs currently rely on static config in the AgentProvider and a user prompt embedded in the event payload. Changing the system prompt requires editing provider config and redeploying, and there is no safe way to pass per-run system prompt values from AgentRun or ImplementationSpec.

## Goals
- Support per-run custom system prompt for AgentRun executions, with optional defaults at Agent level.
- Allow prompts to be supplied inline or by reference (ConfigMap/Secret) for size and sensitivity.
- Ensure Codex runs (workflow/job/temporal) apply the system prompt without breaking existing runs.
- Preserve auditability via hashes/metadata without leaking secret prompt contents.

## Non-Goals
- Redesigning the Codex user prompt builder or issue ingestion flows.
- Providing a UI for system prompt management in this phase.
- Expanding behavior for non-Codex providers beyond pass-through availability.

## Current State (Source Code)
- Jangar builds the run payload from ImplementationSpec text/summary and parameters, placing `prompt` in the event payload used by codex runs. See `services/jangar/src/server/agents-controller.ts`.
- `codex-implement` reads the event payload, sets `CODEX_PROMPT`, and runs Codex; no system prompt is applied. See `services/jangar/scripts/codex/codex-implement.ts`.
- `CodexRunner` uses `codex exec` with a limited set of `--config` overrides and does not expose system prompt options. See `packages/codex/src/runner.ts`.

## Cluster State (2026-02-05)
- `AgentProvider/codex` in namespace `agents` mounts `/root/.codex/config.toml` with model + sandbox config only; no instructions/system prompt keys are present. (kubectl get agentproviders.agents.proompteng.ai codex -n agents)
- `Agent/codex-agent` and other Codex agents exist in `agents` namespace with no config overrides. (kubectl get agents.agents.proompteng.ai -n agents)
- `WorkflowTemplate/codex-run` in namespace `jangar` accepts a `prompt` parameter and builds an event JSON with `prompt`, `repository`, `issueNumber`, `base`, `head`, `stage`, and iteration fields; no system prompt parameter is defined. (kubectl get workflowtemplate codex-run -n jangar)

## Design

### API Additions
Add optional system prompt fields to AgentRun and Agent:

```yaml
spec:
  systemPrompt: string
  systemPromptRef:
    kind: Secret|ConfigMap
    name: string
    key: string
```

Agent defaults:

```yaml
spec:
  defaults:
    systemPrompt: string
    systemPromptRef:
      kind: Secret|ConfigMap
      name: string
      key: string
```

Validation:
- `systemPrompt` maxLength: 16384 (configurable) to avoid etcd bloat.
- If `systemPromptRef` is set, the referenced object must be in the same namespace as the AgentRun.
- `systemPrompt` is treated as non-secret; sensitive content should use `systemPromptRef`.

### Resolution Order
1. `AgentRun.spec.systemPromptRef`
2. `AgentRun.spec.systemPrompt`
3. `Agent.spec.defaults.systemPromptRef`
4. `Agent.spec.defaults.systemPrompt`
5. No system prompt override (current behavior)

### Controller Changes (Jangar)
- Resolve system prompt per the precedence above.
- Inline prompt: include `systemPrompt` in the run payload passed to `agent-runner` (event JSON).
- Ref prompt: mount the referenced Secret/ConfigMap into the runtime pod at `/workspace/.codex/system-prompt.txt` and set env `CODEX_SYSTEM_PROMPT_PATH` to that file.
- Record `systemPromptHash` (SHA-256 of prompt contents) in `AgentRun.status` and in NATS run-started metadata to enable audit without leaking content.

### Runtime Changes (Codex)
- Extend `CodexRunner` to accept `systemPrompt` and pass it as `--config developer_instructions=<toml-string>` to `codex exec`.
- Update `codex-implement` to read `systemPrompt` from the event payload, prefer `CODEX_SYSTEM_PROMPT_PATH` when set, and pass the resolved prompt to `CodexRunner`.
- Avoid logging system prompt contents in runtime logs. Log only the hash or length.

### Workflow Template Changes
- Add `system_prompt` parameter to `codex-run` workflow template.
- Inject `system_prompt` into the event JSON payload so direct Argo runs can set it.
- Pass `CODEX_SYSTEM_PROMPT_PATH` only when provided via secret reference (future-ready for external triggers).

### Provider Pass-Through
- Expose `systemPrompt` in the run payload so other providers can use `{{parameters.systemPrompt}}` in their templates if desired. No behavior changes for non-Codex providers in this phase.

## Data Flow (Codex, Inline Prompt)
1. AgentRun created with `spec.systemPrompt`.
2. Jangar resolves system prompt and adds it to the event payload.
3. `agent-runner` writes event JSON to disk.
4. `codex-implement` reads event JSON and extracts `systemPrompt`.
5. `CodexRunner` invokes `codex exec -c developer_instructions="<prompt>"`.

## Data Flow (Codex, Ref Prompt)
1. AgentRun created with `spec.systemPromptRef`.
2. Jangar mounts referenced object as `/workspace/.codex/system-prompt.txt`.
3. `codex-implement` reads `CODEX_SYSTEM_PROMPT_PATH`.
4. `CodexRunner` invokes `codex exec -c developer_instructions="<prompt>"`.

## Rollout Plan
1. Update CRDs and Helm chart schema for Agent and AgentRun.
2. Implement Jangar controller resolution + hash reporting.
3. Update `CodexRunner` + `codex-implement` to apply system prompt.
4. Update Argo workflow templates (`codex-run`, `codex-autonomous`, `github-codex-implementation`) to accept `system_prompt`.
5. Add docs in `docs/agents/runbooks.md` and `docs/agents/agentctl.md` with examples.
6. Deploy to `agents-ci`, validate, then roll to `agents`.

## Acceptance Criteria
- AgentRun can specify a system prompt inline or by ref; the resulting Codex run uses it.
- Existing runs without system prompt behave unchanged.
- System prompt contents are not logged; only hash or size is recorded.
- Workflow templates accept `system_prompt` and produce correct event payloads.
- Controller rejects AgentRuns with missing secret refs or oversized prompts.

## Open Questions
- Final max length for inline system prompt (16 KB vs 64 KB).
- Should system prompt also be included in `metadata.map` for contract validation, or excluded by default?
