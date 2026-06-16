# Anypi

Anypi is the lightweight Agents provider for running Pi as an autonomous coding harness against the self-hosted
Flamingo model.

## Runtime Contract

- Provider: `anypi`
- Agent: `anypi-agent`
- Binary: `/usr/local/bin/anypi-runner`
- Runtime type: `job`
- Required workload image: `registry.ide-newton.ts.net/lab/anypi:b18caf3d8@sha256:101b15a3323213c45d29665d9855a67e07a132b13b366107f307476dcb96b874`
- Default model endpoint: `http://flamingo.flamingo.svc.cluster.local/v1`
- Default model: `qwen3-coder-flamingo`
- Supported workload image platforms: `linux/amd64`, `linux/arm64`

The provider is an Agents `exec` provider. The controller mounts `/workspace/run.json`, injects `VCS_*` and
`GH_TOKEN/GITHUB_TOKEN`, then starts the Anypi binary directly. Anypi clones the repository, checks out the AgentRun head
branch, invokes Pi through the TypeScript SDK, validates the result, commits, pushes, and opens or updates a PR.

## Pi SDK Configuration

Anypi embeds `@earendil-works/pi-coding-agent` with `createAgentSession()`.

- `ANYPI_TOOLS=all` enables the full built-in coding tool set: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- `ANYPI_THINKING_LEVEL=off` is the default because Flamingo/Qwen3 Coder is served through vLLM without reasoning-effort
  support.
- `ANYPI_BASE_URL`, `ANYPI_PROVIDER`, and `ANYPI_MODEL` configure the generated Pi `models.json`.
- `ANYPI_PROMPT_VARIANT` selects the runner-owned system prompt candidate. Valid values are `minimal`,
  `finish-gated`, `repair-loop`, and `strict-repo`.
- `ANYPI_ALLOW_SYSTEM_PROMPT_OVERRIDE=false` keeps `Agent.spec.defaults.systemPrompt` or run-payload prompt drift from
  bypassing prompt-variant evaluation. The Agent still carries a controller-required placeholder `systemPrompt`; Anypi
  logs and ignores it unless this override flag is explicitly enabled.
- Sessions are persisted under `/workspace/.anypi/sessions`; the active session file path is written into
  `/workspace/.agent/status.json`.
- `ANYPI_MODEL_READY_TIMEOUT_SECONDS=1800` makes the runner wait for `GET /v1/models` before starting Pi, which avoids
  empty runs while Flamingo is cold-loading the model.
- `ANYPI_VALIDATION_POLICY=append` combines inferred service checks, run-provided checks, and provider checks. The runner
  refuses to continue when the only validation command is `git diff --check`.
- `ANYPI_VALIDATION_REPAIR_ATTEMPTS=2` gives Pi two bounded repair passes when a runner-side validation command fails.
  The runner still refuses to commit or push unless all validation commands pass.
- `ANYPI_NO_CHANGE_REPAIR_ATTEMPTS=2` gives Pi two bounded continuation prompts if a session exits without leaving
  code changes. The run still fails if the worktree is unchanged after those attempts.
- `ANYPI_CI_REPAIR_ATTEMPTS=1` makes the runner wait for required GitHub checks after opening the PR and run one bounded
  repair pass if those checks fail.

## Prompt Contract

The system prompt is a measured runner artifact, not a fixed Agent default. The default provider starts with `minimal`;
`anypi-eval-agent` runs comparative variants through `ANYPI_PROMPT_VARIANT={{parameters.promptVariant}}`. The Kubernetes
`Agent` placeholder exists only because the Agents controller requires a `defaults.systemPrompt` field before it will
materialize a run.

Prompt variants are intentionally small and repo-focused. They do not mention Anypi, yolo mode, Kubernetes, Flamingo, or
the Pi SDK. Runtime details stay in runner config and logs, not in the model's behavioral contract. Root `AGENTS.md` is
injected as repository context.

Status evidence is written to `/workspace/.agent/status.json`: `promptVariant`, `promptHash`, `validationPlan`,
`validations`, `ci`, `ciAttempts`, `sessionFiles`, `commit`, and `pullRequest`.

## AgentRun Example

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: anypi-torghut-quality-20260616
  namespace: agents
spec:
  agentRef:
    name: anypi-agent
  implementation:
    inline:
      summary: Improve Torghut diff coverage reporting
      text: |
        Improve services/torghut/scripts/check_diff_coverage.py so uncovered executable changed lines are reported
        with actionable file:line details. Add regression tests in services/torghut/tests/test_check_diff_coverage.py.
        Run the focused tests and leave the worktree changed for the runner to commit.
  runtime:
    type: job
  ttlSecondsAfterFinished: 86400
  vcsRef:
    name: github
  vcsPolicy:
    required: true
    mode: read-write
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/anypi-torghut-quality-20260616
    validationCommands: |
      git diff --check
      cd services/torghut && uv sync --frozen --extra dev
      cd services/torghut && uv run --frozen ruff format --check app tests scripts migrations
      cd services/torghut && uv run --frozen pytest tests/test_check_diff_coverage.py -q
      cd services/torghut && uv run --frozen pyright --project pyrightconfig.json
      cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json
      cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json
  secrets:
    - github-token
  workload:
    image: registry.ide-newton.ts.net/lab/anypi:b18caf3d8@sha256:101b15a3323213c45d29665d9855a67e07a132b13b366107f307476dcb96b874
    resources:
      requests:
        cpu: '2'
        memory: 4Gi
        ephemeral-storage: 12Gi
      limits:
        memory: 12Gi
        ephemeral-storage: 24Gi
```

Do not set `spec.parameters.prompt`; the task belongs in `ImplementationSpec.spec.text` or
`spec.implementation.inline.text`.

## Rollout

1. Build and push:

   ```bash
   bun run build:anypi
   docker buildx imagetools inspect registry.ide-newton.ts.net/lab/anypi:<tag>
   ```

2. Pin the resulting image digest in the validation AgentRun `spec.workload.image`.
3. Sync `argocd/agents`.
4. Verify:

   ```bash
   kubectl -n agents get agentprovider anypi
   kubectl -n agents get agent anypi-agent
   ```

5. Submit the Torghut validation AgentRun and monitor:

   ```bash
   kubectl -n agents get agentrun anypi-torghut-quality-20260616
   kubectl -n agents logs -f job/$(kubectl -n agents get job -l agents.proompteng.ai/agent-run=anypi-torghut-quality-20260616 -o jsonpath='{.items[0].metadata.name}')
   ```

Acceptance requires a Succeeded AgentRun, a pushed `codex/...` branch, and an opened PR containing real Torghut code and
test changes with required GitHub checks green. The runner does not auto-merge.
