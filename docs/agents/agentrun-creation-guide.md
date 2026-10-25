# AgentRun Creation Guide (Prompt Contract)

Status: Current (2026-03-04)

Docs index: [README](README.md)

## Purpose

Create AgentRuns that actually execute the intended ImplementationSpec without accidentally narrowing scope (for example,
turning a “ship code + chart” task into a docs-only PR).

This guide focuses on prompt precedence and the minimum fields needed for reliable runs.

## Implementation Source Is Provenance

`implementation.inline.source` records the task's external identity. It does not configure a
webhook, authorize a workspace, or select a team/project. Keep it to the generic contract:

```yaml
source:
  provider: linear
  externalId: PROOMPT-123
  url: https://linear.app/proompteng/issue/PROOMPT-123/example
```

Agents enforce `Agent.spec.security.allowedImplementationSourceProviders` at API admission and
again in direct Job and Workflow reconciliation. Public provider webhooks belong to Froussard after
cutover; `/v1/implementation-sources/webhooks/{provider}` returns `410 Gone` only when
`AGENTS_IMPLEMENTATION_SOURCE_WEBHOOKS_GONE=true` after the Froussard canary succeeds.

The opt-in `codex-linear-agent` additionally binds the source issue to a restricted Linear MCP
surface. Its projected workload-identity token contains no Linear credential. See
[`linear-mcp.md`](linear-mcp.md) for the policy and canary contract.

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
  goal:
    objective: Implement leader election end to end and verify the chart/runtime rollout path.
    tokenBudget: 64000
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/agents/leader-election-implementation-20260207
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
- Codex provider images include the official Alpaca MCP server. Runs that need Alpaca tools should list an allowed
  secret such as `alpaca-mcp` in `spec.secrets`; the secret must provide `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`.
- `ttlSecondsAfterFinished` is a top-level `AgentRun.spec` field (see `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`).
  Do not put TTL under `spec.runtime.config` unless a specific runtime explicitly documents it.
- The controller also runs a bounded namespace retention sweep. `ttlSecondsAfterFinished: 0` disables normal per-run TTL,
  but production can still apply `controller.agentRunRetentionZeroTtlMaxSeconds` as a safety cap for old terminal runs.
  Use annotation `agents.proompteng.ai/retain: "true"` only for rare terminal runs that must be retained beyond that cap.
- `goal` is a top-level `AgentRun.spec` object. Use `goal.objective` for the persistent Codex goal and optional
  `goal.tokenBudget` for an explicit positive token budget. Do not encode the first-class goal as
  `parameters.prompt`.
- Keep `metadata.name` short enough for label propagation. The controller writes
  `agents.proompteng.ai/agent-run=<run-name>` labels, so names longer than 63 characters can fail reconciliation.
- Prefer omitting `spec.workload.image` unless you intentionally pin a known-good runner image.

## Create An AgentRun With A Codex Goal

Use `spec.goal` when the run should carry a persistent Codex goal in addition to the task prompt. The prompt still comes
from `ImplementationSpec.spec.text` or `spec.implementation.inline.text`; the goal is separate runtime state used by
goal-aware Codex clients.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: codex-goal-smoke-20260517
  namespace: agents
spec:
  agentRef:
    name: codex-spark-agent
  implementation:
    inline:
      text: |
        Verify the goal-aware runner path without making source changes.
        Report whether the generated run payload includes the expected goal.
  goal:
    objective: Verify Codex goal support in the AgentRun runtime.
    tokenBudget: 8000
  ttlSecondsAfterFinished: 7200
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/agentrun-goal-smoke-20260517
    stage: verification
  runtime:
    type: workflow
  secrets:
    - codex-openai-key
  workflow:
    steps:
      - name: verify
        parameters:
          stage: verify
        timeoutSeconds: 1800
  workload:
    resources:
      requests:
        cpu: 500m
        memory: 1024Mi
```

Rules:

- `spec.goal.objective` is required when `spec.goal` is present. It must be a non-empty string.
- `spec.goal.tokenBudget` is optional. If set, it must be a positive integer.
- To run with a goal and no token budget, omit `spec.goal.tokenBudget` entirely. Do not set it to `0`, `null`, or an
  empty string.
- Do not put the goal in `spec.parameters.prompt`; that field is rejected and would also override the task prompt model.
- Do not put persistent Codex goal fields in `spec.parameters`; the controller only reads goal data from
  top-level `spec.goal`.
- Runs that need Alpaca tools should add the allowed `alpaca-mcp` Secret to `spec.secrets`. That secret must contain
  `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`; Codex provider images already include the `alpaca-mcp-server` binary and
  provider config.

### Goal Without A Token Budget

Use this form when the run needs persistent goal state, but should not have a fixed token budget.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: codex-goal-no-budget-smoke-20260525
  namespace: agents
spec:
  agentRef:
    name: codex-spark-agent
  implementation:
    inline:
      text: |
        Verify the goal-aware runner path without a token budget.
        Inspect the generated run payload and report the goal object.
  goal:
    objective: Verify Codex goal support without an explicit token budget.
  ttlSecondsAfterFinished: 7200
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/agentrun-goal-no-budget-smoke-20260525
    stage: verification
  runtime:
    type: workflow
  secrets:
    - codex-openai-key
  workflow:
    steps:
      - name: verify
        parameters:
          stage: verify
        timeoutSeconds: 1800
  workload:
    resources:
      requests:
        cpu: 500m
        memory: 1024Mi
```

After apply, verify that the generated payload contains the objective and does not contain `tokenBudget`:

```bash
RUN=codex-goal-no-budget-smoke-20260525

CM=$(kubectl -n agents get cm -l agents.proompteng.ai/agent-run="$RUN" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n agents get cm "$CM" -o jsonpath='{.data.run\.json}' | jq '.goal'
kubectl -n agents get cm "$CM" -o jsonpath='{.data.run\.json}' | jq '.goal | has("tokenBudget")'
```

Expected payload shape:

```json
{
  "objective": "Verify Codex goal support without an explicit token budget."
}
```

The `has("tokenBudget")` check should print `false`.

After apply, verify the controller materialized the goal into the generated run payload:

```bash
RUN=codex-goal-smoke-20260517

kubectl -n agents get agentrun "$RUN" -o yaml | rg -n 'goal:|objective:|tokenBudget:'

CM=$(kubectl -n agents get cm -l agents.proompteng.ai/agent-run="$RUN" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n agents get cm "$CM" -o jsonpath='{.data.run\.json}' | jq '.goal'
kubectl -n agents get cm "$CM" -o jsonpath='{.data.agent-runner\.json}' | jq '.goal'
```

Expected payload shape:

```json
{
  "objective": "Verify Codex goal support in the AgentRun runtime.",
  "tokenBudget": 8000
}
```

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
2. `AgentProvider.spec.workload.image`
3. `AGENTS_AGENT_RUNNER_IMAGE`
4. chart `runner.image.*`

Runner image entry points by interface:

- HTTP `/v1/agent-runs`: `spec.workload.image` (and workflow step `spec.workflow.steps[].workload.image`)
- gRPC `SubmitAgentRun`: `workload.image` (mapped into `AgentRun.spec.workload.image`)
- Native `OrchestrationRun` AgentRun steps: `step.workload.image` (mapped into submitted `AgentRun.spec.workload.image`)
- Controller fallback defaults: `AgentProvider.spec.workload.image`, `AGENTS_AGENT_RUNNER_IMAGE`, then the chart-managed
  runner image.

Chart default wiring for `AGENTS_AGENT_RUNNER_IMAGE` (highest first):

1. `env.vars.AGENTS_AGENT_RUNNER_IMAGE`
2. `runner.image.*`
3. chart default runner image

Safe default for normal runs:

- Do not set `spec.workload.image`; let the AgentProvider or controller-provided default image drive execution.

Use per-run image pinning only when:

- you are running a controlled canary/debug experiment, and
- you have verified the exact image is compatible with the configured agent provider/runtime.

## Runner Resource Selection

Resource resolution order for Job containers (lowest to highest precedence):

1. chart/controller defaults from `controller.defaultWorkload.resources` / `AGENTS_AGENT_RUNNER_RESOURCES`
2. `AgentProvider.spec.workload.resources`
3. `AgentRun.spec.runtime.config.resources`
4. `AgentRun.spec.workload.resources` or workflow step `workload.resources`

Use `spec.workload.resources` for normal per-run sizing. `spec.runtime.config.resources` is accepted for runtime-level
submissions and is overridden by explicit workload resources.

## Verify The Run Is Using The Spec Text

After `kubectl apply`:

```bash
kubectl get agentrun -n agents leader-election-implementation-20260207-run -o yaml

# Inspect the generated run payload written by the controller
kubectl get cm -n agents -l agents.proompteng.ai/agent-run=leader-election-implementation-20260207-run -o name
kubectl get cm -n agents <run-spec-configmap> -o yaml | rg -n 'run.json:|\"prompt\"' -n
```

If `run.json.prompt` contains your ImplementationSpec `text`, you did not override the prompt.
If `spec.goal` is set, `run.json.goal.objective` should contain the goal text.

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
