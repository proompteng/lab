# GPT-6 Astra upgrade

The repository's OpenAI and Codex text-generation defaults use `gpt-6-astra`. The model ID and request requirements
come from the [OpenAI migration guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart).

## Scope and compatibility

- Codex clients, container and workspace templates, Agents providers, Jangar chat, Sag, Bumba's hosted completion
  default, and Torghut's LLM default select Astra.
- The `codex-spark` provider retains its resource name for existing consumers and selects Astra for new runs.
- Existing supported reasoning efforts remain unchanged. Astra requests use `low` when an older configuration
  selects `none` or `minimal`.
- Astra requests omit `temperature`, `top_p`, and log-probability parameters. Tool calls use the Codex app server's
  Responses transport. Plain text completions can continue using Chat Completions.
- Self-hosted inference, embeddings, explicit compatibility fallbacks, and historical evaluation records retain
  their model identities. Environment and per-run model overrides still take precedence over defaults.
- Jangar's production model inventory includes Astra alongside its existing Qwen default, allowing callers to
  select `gpt-6-astra` explicitly.
- Codex CLI must be at least `0.153.0` for Astra, as documented in
  [OpenAI's Codex setup guidance](https://help.openai.com/en/articles/20001354). The shared runtime pins `0.153.4`.
  Older clients reject Astra before inference, even with valid credentials.
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
match the selected model. Existing DSPy artifacts and strategy qualification evidence require the normal
acceptance process before they can establish quality or trading readiness with Astra.

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
for app in agents autotrader synthesis torghut workers; do
  kustomize build --enable-helm "argocd/applications/$app" > /dev/null || exit 1
done
```
