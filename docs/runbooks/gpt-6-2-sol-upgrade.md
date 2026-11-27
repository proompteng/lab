# GPT-6.2 Sol and Codex 0.172.0 upgrade

The repository uses Codex `0.172.0` and defaults hosted OpenAI text generation and Codex tasks to `gpt-6.2-sol`.
See the [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.172.0) and
[OpenAI migration guide](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart).

## Scope and compatibility

- The shared Nix CLI, service Dockerfiles, workers, devbox, and Nanoagent use the release pin. Generate the
  `packages/codex` app-server types with that same CLI. Nanoagent validates the archive digest for its architecture.
- Codex clients, container and workspace templates, Agents providers, Jangar, OpenWebUI, Symphony, Sag, Tengri,
  Bumba's hosted completion path, and Torghut's LLM configuration default to Sol.
- Symphony resolves `codex.model` for each thread and turn. Workflow and per-run model overrides take precedence.
- Jangar and OpenWebUI default to Sol through the signed-in Codex app server. Callers can select `qwen38-flamingo`
  for self-hosted inference. Bumba's self-hosted endpoint uses the model configured for that endpoint.
- GPT-6.2 Sol requests omit `temperature`, `top_p`, and log-probability controls. Map legacy `none` or `minimal`
  reasoning settings to `low`. GPT-6.2 Sol uses Responses for tool calls and supports Chat Completions for plain text.
- Jangar sets `HOME=/root` and `CODEX_HOME=/root/.codex`, includes the container configuration there, and uses the
  existing mounted `auth.json`. Renew an expired credential for the same verified account through
  `bun run scripts/sync-codex-auth-1password.ts sync` and the existing ExternalSecrets reconciliation. New pods
  consume the renewed secret; existing subPath mounts retain their original contents until replacement.
- Jangar's Nix image derives its configuration from the container template and omits the Alpaca MCP entry because
  that image does not package the executable. The Docker template retains the entry for its bundled server.

## Rollout and impact

Merge the validated change through the normal CI process. Image delivery follows each service's existing Kargo
pipeline and Argo reconciliation. Provider manifests take effect through their owning Argo applications. Do not
deploy a worktree image, patch live workloads, or manually retag images for this change.

New AgentRuns select the updated provider model. Existing runs retain their resolved configuration. Worker
cloud-init changes affect provisioning; existing hosts need the normal Codex configuration sync before their
local default changes. The repository template does not modify a developer's existing `~/.codex/config.toml`.

Model selection changes output, token usage, latency, and cost. Torghut's model version lock and allowlist must
match the selected model. Use the normal acceptance process to qualify DSPy artifacts and trading strategies
for GPT-6.2 Sol.

## Acceptance and rollback

After delivery, verify the exact source revision and image provenance, Argo application state, and running
workload configuration. Check a fresh Codex run's resolved model and completion, Jangar's `/v1/models` plus a
completed chat response, and Torghut's configured model identity plus a successful review. Confirm the running
Codex CLI meets the minimum version and discovers the mounted credentials. An advertised model
or a healthy workload alone does not prove inference succeeds.

Rollback uses a Git revert through the same delivery process. Restore the model defaults and associated request
compatibility changes together. No schema or data migration is required.

## Local validation

Run from the repository root:

```bash
bun test packages/scripts/src/agents/__tests__/smoke-agents.test.ts
bun run --filter @proompteng/codex test -- src/app-server-client.events.test.ts
bun run --filter @proompteng/agents test -- src/runner/codex-app-server.test.ts src/server/agents-controller/job-runtime.test.ts src/server/agents-controller/index.integration.test.ts
bun test services/bumba/src/activities/index.test.ts services/bumba/src/event-consumer.test.ts
bunx tsc --noEmit -p services/bumba/tsconfig.json
```

Run the chat contract tests from `services/jangar`:

```bash
bunx vitest run --config vitest.config.ts src/server/__tests__/chat-config.test.ts src/server/__tests__/chat-completion-encoder.test.ts src/server/__tests__/torghut-decision-engine.test.ts src/server/__tests__/chat-completions.test.ts
```

Run the DSPy and configuration checks from `services/torghut`:

```bash
uv run --frozen --extra dev pytest -q \
  tests/test_llm_dspy_committee_programs.py \
  tests/test_llm_dspy_runtime.py \
  tests/test_llm_dspy_dataset.py \
  tests/llm_dspy_workflow/test_compile_result_is_deterministic.py \
  tests/config/test_tigerbeetle_settings_are_normalized.py
uv run --frozen --extra dev pyright --project pyrightconfig.json
```

Render the affected Argo applications from the root Nix development shell:

```bash
for app in agents autotrader jangar synthesis torghut workers; do
  kustomize build --enable-helm "argocd/applications/$app" > /dev/null || exit 1
done
```
