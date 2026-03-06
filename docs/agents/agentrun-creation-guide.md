# AgentRun Creation Guide (Prompt Contract)

Status: Current (2026-03-04)

Docs index: [README](README.md)

## Purpose

Create AgentRuns that actually execute the intended ImplementationSpec without accidentally narrowing scope (for example,
turning a “ship code + chart” task into a docs-only PR).

This guide focuses on prompt precedence and the minimum fields needed for reliable runs.

## Prompt Source Rules (No Run-Level Overrides)

The Codex runner ultimately receives a single “user prompt” string in the generated run payload (`run.json.prompt`).

Allowed sources (highest first):

1. `ImplementationSpec.spec.text` (when `spec.implementationSpecRef` is used)
2. `AgentRun.spec.implementation.inline.text` (when inline implementations are used)

Disallowed:

- `AgentRun.spec.parameters.prompt`
- `AgentRun.spec.workflow.steps[].parameters.prompt`

`parameters.prompt` is rejected at API/controller validation time and CRD validation. Use
`ImplementationSpec.spec.text` as the task source of truth.

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
    issueNumber: '0'
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
- Prefer omitting `spec.workload.image` unless you intentionally pin a known-good runner image.

## Preflight: Validate References Before `kubectl apply`

Run this check before creating an AgentRun:

```bash
RUN_NS=agents
AGENT_NAME=codex-agent
VCS_PROVIDER=github
SECRETS=(codex-github-token codex-openai-key)

kubectl -n "$RUN_NS" get agent "$AGENT_NAME"
kubectl -n "$RUN_NS" get versioncontrolprovider "$VCS_PROVIDER"

for s in "${SECRETS[@]}"; do
  kubectl -n "$RUN_NS" get secret "$s" >/dev/null || echo "missing secret: $s"
done
```

Rules:

- Every entry listed under `spec.secrets` must exist in the target namespace.
- If a secret is missing and not required for your current provider/runtime path, remove it from `spec.secrets`
  before apply.
- If a secret is required, create it first; otherwise pod startup will fail with `CreateContainerConfigError`.

Common failure signature:

```bash
kubectl -n agents describe pod <agent-run-pod> | rg -n 'CreateContainerConfigError|secret ".*" not found'
```

## Runner Image Selection (Avoid Accidental Overrides)

Image resolution order (highest first):

1. `AgentRun.spec.workload.image`
2. `JANGAR_AGENT_RUNNER_IMAGE`
3. `JANGAR_AGENT_IMAGE`

Runner image entry points by interface:

- HTTP `/v1/agent-runs`: `spec.workload.image` (and workflow step `spec.workflow.steps[].workload.image`)
- gRPC `SubmitAgentRun`: `workload.image` (mapped into `AgentRun.spec.workload.image`)
- Native `OrchestrationRun` AgentRun steps: `step.workload.image` (mapped into submitted `AgentRun.spec.workload.image`)
- Controller fallback defaults: `JANGAR_AGENT_RUNNER_IMAGE`, then `JANGAR_AGENT_IMAGE`

Chart default wiring for `JANGAR_AGENT_RUNNER_IMAGE` (highest first):

1. `env.vars.JANGAR_AGENT_RUNNER_IMAGE`
2. `runner.image.*`
3. `runtime.agentRunnerImage` (legacy fallback)

Safe default for normal runs:

- Do not set `spec.workload.image`; let the controller-provided default image drive execution.

Use per-run image pinning only when:

- you are running a controlled canary/debug experiment, and
- you have verified the exact image is compatible with the configured agent provider/runtime.

## Verify The Run Is Using The Spec Text

After `kubectl apply`:

```bash
kubectl get agentrun -n agents leader-election-implementation-20260207-run -o yaml

# Inspect the generated run payload written by the controller
kubectl get cm -n agents -l agents.proompteng.ai/agent-run=leader-election-implementation-20260207-run -o name
kubectl get cm -n agents <run-spec-configmap> -o yaml | rg -n 'run.json:|\"prompt\"' -n
```

If `run.json.prompt` contains your ImplementationSpec `text`, you did not override the prompt.

If `run.json.prompt` does not contain the expected ImplementationSpec text, fail the run setup and fix the spec.

## Verify System Prompt Is Actually Enforced

If the Agent relies on `defaults.systemPromptRef`, validate the runtime pod before trusting results:

```bash
RUN=leader-election-implementation-20260207-run
JOB=$(kubectl -n agents get jobs -l agents.proompteng.ai/agent-run="$RUN" -o jsonpath='{.items[0].metadata.name}')
POD=$(kubectl -n agents get pod -l job-name="$JOB" -o jsonpath='{.items[0].metadata.name}')

kubectl -n agents get pod "$POD" \
  -o jsonpath='{range .spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | rg 'CODEX_SYSTEM_PROMPT_PATH|CODEX_SYSTEM_PROMPT_EXPECTED_HASH|CODEX_SYSTEM_PROMPT_REQUIRED'

kubectl -n agents exec "$POD" -- /bin/bash -lc \
  'test -f /workspace/.codex/system-prompt.txt && sha256sum /workspace/.codex/system-prompt.txt | awk "{print \$1}"'

kubectl -n agents get agentrun "$RUN" -o jsonpath='statusSystemPromptHash={.status.systemPromptHash}{"\n"}'
```

Required:

- `CODEX_SYSTEM_PROMPT_PATH` present and points to mounted prompt file.
- `CODEX_SYSTEM_PROMPT_REQUIRED=true`.
- `CODEX_SYSTEM_PROMPT_EXPECTED_HASH` matches mounted file hash and `status.systemPromptHash`.

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

# If no logs are available yet, inspect pod startup errors:
kubectl -n agents get pod -l job-name=<job-name>
kubectl -n agents describe pod <pod-name>
```

## Loop Workflow Examples

If you want one step to run multiple iterations while reusing the same workspace/state volume, start from:

- `charts/agents/examples/agentrun-workflow-loop-fixed.yaml`
- `charts/agents/examples/agentrun-workflow-loop-conditional.yaml`
- `docs/agents/agentrun-workflow-loop-launch-guide.md` (operational launch checklist, verification, troubleshooting)

Notes:

- Use `runtime.type: workflow`.
- Ensure loop state volumes are PVC-backed and reused across iterations.
- Conditional loops use CEL expressions under `workflow.steps[].loop.condition.expression`.

## `parameters.prompt` Policy

`spec.parameters.prompt` is not supported for AgentRuns. Define the task in `ImplementationSpec.spec.text` (or
`spec.implementation.inline.text` for inline runs).

## System Prompt Versus User Prompt

System prompt:

- Configures “how the agent behaves” (process, constraints, formatting, safety).
- Comes from Agent defaults only (`Agent.spec.defaults.systemPrompt` or `Agent.spec.defaults.systemPromptRef`).
- See `docs/agents/designs/custom-system-prompt-agent-runs.md`.

User prompt:

- Describes “what to do” for this run.
- Comes from `ImplementationSpec.spec.text` (or inline implementation text).

Do not use system prompt customization to compensate for an incorrect user prompt.

## Common Pitfalls Checklist

- You tried to use `spec.parameters.prompt` (this is rejected by validation).
- You used a multi-step workflow (`plan` + `implement`) for a design-doc run that should have been a single `implement` step.
- You referenced the wrong `ImplementationSpec` (check `spec.implementationSpecRef.name`).
- You assumed `${parameter}` placeholders were auto-expanded in prompt text without verifying `run.json.prompt`.
- You used a head branch that conflicts with another active run (see `docs/agents/version-control-provider-design.md`).
- Your `AgentRun.metadata.name` exceeded 63 chars and failed when propagated into Kubernetes label values.
- You set `spec.workload.image` to a stale/incompatible image instead of inheriting controller defaults.
- Required secrets were not allowlisted or not included in `spec.secrets`.
- A secret referenced in `spec.secrets` does not exist in the run namespace (`CreateContainerConfigError`).
- The repo is not in the allowlist configured for the controllers deployment.
- You expected “followers not-ready” behavior without having implemented leader election in code and chart.
