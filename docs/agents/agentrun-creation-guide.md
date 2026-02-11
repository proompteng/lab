# AgentRun Creation Guide (Prompt Precedence)

Status: Current (2026-02-11)

Docs index: [README](README.md)

## Purpose

Create AgentRuns that actually execute the intended ImplementationSpec without accidentally narrowing scope (for example,
turning a “ship code + chart” task into a docs-only PR).

This guide focuses on prompt precedence and the minimum fields needed for reliable runs.

## Prompt Precedence (The Common Failure Mode)

The Codex runner ultimately receives a single “user prompt” string in the generated run payload (`run.json.prompt`).

Precedence (highest first):

1. `AgentRun.spec.parameters.prompt` (if set)
2. `ImplementationSpec.spec.text` (when `spec.implementationSpecRef` is used)
3. `AgentRun.spec.implementation.inline.text` (when inline implementations are used)

Rule:

If you are running an ImplementationSpec, do not set `AgentRun.spec.parameters.prompt` unless you intentionally want to
override the ImplementationSpec text.

Why:

`parameters.prompt` is treated as authoritative. If you set it to something like “Implement docs/...”, the runner will
optimize for that smaller scope even if the referenced ImplementationSpec asks for code, chart, and validation changes.

## Minimal AgentRun (Reference An ImplementationSpec, No Prompt Override)

Example: run an existing `ImplementationSpec` and let the spec’s `text` drive the work.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: leader-election-implementation-20260207-run
  namespace: agents
spec:
  agentRef:
    name: codex-agent
  implementationSpecRef:
    name: leader-election-design-20260207
  ttlSecondsAfterFinished: 7200
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/agents/leader-election-implementation-20260207
    issueNumber: "0"
    issueTitle: Implement leader election (code + chart)
    issueUrl: https://github.com/proompteng/lab/blob/main/docs/agents/leader-election-design.md
    stage: implementation
  runtime:
    type: workflow
  secrets:
  - codex-github-token
  - codex-openai-key
  workflow:
    steps:
    - name: implement
      parameters:
        stage: implement
      timeoutSeconds: 7200
  workload:
    resources:
      requests:
        cpu: 500m
        memory: 1024Mi
```

Notes:

- The `head` branch must be writable by the configured VCS provider and should follow the repo’s conventions
  (this repo typically uses `codex/...` prefixes).
- For design-doc implementation runs, prefer a single workflow step named `implement`. Add a separate `plan` step only
  when you need a distinct planning artifact.
- Secrets are cluster- and provider-specific. If you reference a Secret (directly or via `systemPromptRef`) it must be
  allowed by policy and often must be listed in `spec.secrets` (see `docs/agents/rbac-matrix.md`).
- `ttlSecondsAfterFinished` is a top-level `AgentRun.spec` field (see `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`).
  Do not put TTL under `spec.runtime.config` unless a specific runtime explicitly documents it.
- Keep `metadata.name` short enough for label propagation. The controller writes
  `agents.proompteng.ai/agent-run=<run-name>` labels, so names longer than 63 characters can fail reconciliation.

## Verify The Run Is Using The Spec Text

After `kubectl apply`:

```bash
kubectl get agentrun -n agents leader-election-implementation-20260207-run -o yaml

# Inspect the generated run payload written by the controller
kubectl get cm -n agents -l agents.proompteng.ai/agent-run=leader-election-implementation-20260207-run -o name
kubectl get cm -n agents <run-spec-configmap> -o yaml | rg -n 'run.json:|\"prompt\"' -n
```

If `run.json.prompt` contains your ImplementationSpec `text`, you did not override the prompt.

If `run.json.prompt` contains your `parameters.prompt`, you did override it.

## Parameter Wiring (Avoid Shell-Env Assumptions)

AgentRun parameters are recorded in generated payload files (`run.json.parameters` and `agent-runner.json.inputs`).
Do not assume parameters are exported as shell variables like `$confirm` or `$designDoc` inside the runner container.

If you need literal values in the user prompt:

- put them directly in `ImplementationSpec.spec.text`, or
- verify your rendering path by inspecting generated payloads after apply.

Treat `${key}` tokens in `ImplementationSpec.spec.text` as literal unless you have confirmed expansion in the generated
`run.json.prompt`.

## Monitor Execution

```bash
kubectl get agentrun -n agents leader-election-implementation-20260207-run
kubectl get job -n agents -l agents.proompteng.ai/agent-run=leader-election-implementation-20260207-run -o name
kubectl logs -n agents job/<job-name> -f
```

## When To Use `parameters.prompt` (And When Not To)

Use `parameters.prompt` when:

- You are doing an ad-hoc run without an ImplementationSpec, or you are intentionally overriding the spec’s text for a
  narrow one-off (for example, “summarize logs”).

Avoid `parameters.prompt` when:

- The ImplementationSpec is the source of truth for deliverables (code + chart + validation).
- You are using a “design doc” ImplementationSpec and want it implemented as written.

## System Prompt Versus User Prompt

System prompt:

- Configures “how the agent behaves” (process, constraints, formatting, safety).
- Comes from Agent defaults and optional per-run overrides.
- See `docs/agents/designs/custom-system-prompt-agent-runs.md`.

User prompt:

- Describes “what to do” for this run.
- Comes from `parameters.prompt` or `ImplementationSpec.spec.text` (depending on what you set).

Do not use system prompt customization to compensate for an incorrect user prompt.

## Common Pitfalls Checklist

- You set `spec.parameters.prompt` and unintentionally narrowed the task scope.
- You used a multi-step workflow (`plan` + `implement`) for a design-doc run that should have been a single `implement` step.
- You referenced the wrong `ImplementationSpec` (check `spec.implementationSpecRef.name`).
- You assumed `${parameter}` placeholders were auto-expanded in prompt text without verifying `run.json.prompt`.
- You used a head branch that conflicts with another active run (see `docs/agents/version-control-provider-design.md`).
- Your `AgentRun.metadata.name` exceeded 63 chars and failed when propagated into Kubernetes label values.
- Required secrets were not allowlisted or not included in `spec.secrets`.
- The repo is not in the allowlist configured for the controllers deployment.
- You expected “followers not-ready” behavior without having implemented leader election in code and chart.
