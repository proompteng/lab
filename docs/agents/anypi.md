# Anypi

Anypi is the lightweight Agents provider for running Pi as an autonomous coding harness against the self-hosted
Flamingo model.

## Runtime Contract

- Provider: `anypi`
- Agent: `anypi-agent`
- Binary: `/usr/local/bin/anypi-runner`
- Runtime type: `job`
- Required workload image: `registry.ide-newton.ts.net/lab/anypi:<tag>@<digest>`
- Default model endpoint: `http://flamingo.flamingo.svc.cluster.local/v1`
- Default model: `qwen3-coder-flamingo`

The provider is an Agents `exec` provider. The controller mounts `/workspace/run.json`, injects `VCS_*` and
`GH_TOKEN/GITHUB_TOKEN`, then starts the Anypi binary directly. Anypi clones the repository, checks out the AgentRun head
branch, invokes Pi through the TypeScript SDK, validates the result, commits, pushes, and opens or updates a PR.

## Pi SDK Configuration

Anypi embeds `@earendil-works/pi-coding-agent` with `createAgentSession()`.

- `ANYPI_TOOLS=all` enables the full built-in coding tool set: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- `ANYPI_THINKING_LEVEL=off` is the default because Flamingo/Qwen3 Coder is served through vLLM without reasoning-effort
  support.
- `ANYPI_BASE_URL`, `ANYPI_PROVIDER`, and `ANYPI_MODEL` configure the generated Pi `models.json`.
- Sessions are persisted under `/workspace/.anypi/sessions`; the active session file path is written into
  `/workspace/.agent/status.json`.

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
      cd services/torghut && uv run --frozen pytest tests/test_check_diff_coverage.py -q
  secrets:
    - github-token
  workload:
    image: registry.ide-newton.ts.net/lab/anypi:<tag>@<digest>
    resources:
      requests:
        cpu: "2"
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
test changes. The runner does not auto-merge.
