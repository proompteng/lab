# Hermes configuration profile

The Tuslagch instance runs Hermes `0.21.5`, release `v2026.9.24`, with configuration schema `46`.
[config.yaml](config.yaml) owns persistent settings. [statefulset.yaml](statefulset.yaml) owns process environment,
read-only mounts, and immutable images. Credentials follow the existing External Secrets and SealedSecret paths.
The dashboard is a chat and inspection surface. Persistent changes use a reviewed repository change and the existing
Kargo delivery path.

## Coding and cluster inspection

The primary and active auxiliary tasks use the named `flamingo` provider and `qwen36-flamingo`. Its configured context
matches the server's `262144` tokens. The request body uses Qwen's recommended precise coding parameters: temperature
`0.6`, top-p `0.95`, top-k `20`, min-p `0`, presence penalty `0`, and repetition penalty `1`. Thinking stays enabled for
coding. Title generation disables thinking. Compression and session-query rewriting each admit one auxiliary request
at a time, per process and per task. These limits do not impose a global GPU semaphore.

Compaction starts at `65536` tokens, preserving the first three and last twenty messages, with at least three user
messages in the retained tail. This is an operating limit chosen to bound long-context prefill on the shared Flamingo
GPU, not a measured throughput claim. Hermes's fractional threshold otherwise has a `0.75` floor for this context size.
A failed summary aborts compaction instead of silently discarding the middle of the conversation. Session search can
recover older details from SQLite history. Automatic session pruning is disabled; existing sessions remain retained.

File, memory, session search, terminal, todo, native web, and skills tools are available in CLI, API, and Discord sessions.
The terminal starts at the Lab repository with its pinned toolchain. The Kubernetes role remains read-only. Eighty
agent turns provide room to implement and verify a coding task, with a warning after three quarters of the budget.
Each process admits four live sessions and caches four agents. The API admits two concurrent runs. These bounds retain the
existing shared-service capacity model.

Exa's native search and extract tools are the sole web integration. Removing the duplicate Exa MCP server removes its
connection and duplicate tool schemas. Native web responses have a twenty-minute cache. Keyless fallback and rescue
are disabled so an Exa failure remains visible.

Only the bundled `security-guidance` agent plugin is enabled. It adds pattern-based warnings to file writes and can have
false positives. Dashboard authentication and the native web provider register separately from this optional agent
plugin allowlist. An inactive badge on the Plugins page is not proof that a built-in provider is unavailable.

Skills can discover the explicitly trusted Lab checkout. Inline shell templates stay disabled, and agent-created skills
pass the native guard. Learned skills and memory are mutable retained data. Persistent integrations and plugin
activation still require a repository change. Missing language servers are never installed automatically; add required
binaries through the pinned toolchain before configuring them.

Delegation, agent scheduling, code execution, and Kanban toolsets are disabled. Kanban dispatch, automatic decomposition,
background skill curation, background review, and automatic multiplex migration are also disabled.
This instance has one operator-owned profile. A read-only empty `/opt/data/profiles` mount prevents runtime profile
creation. Hermes serves only the default profile because there are no secondary profiles. The release ignores
`multiplex_profiles: false`; this deployment does not use that retired flag or the temporary standalone compatibility shim. Manual approvals and existing command deny rules remain active.

## GitOps ownership

All bootstrap and runtime containers receive `HERMES_MANAGED=gitops` and a read-only `/opt/data/.managed` marker.
Native configuration writers recognize the managed installation. The read-only configuration and empty `.env` mounts
also enforce filesystem ownership. No dashboard save, runtime plugin installer, or `hermes config set` operation is part
of the production configuration path. Managed-install mode is distinct from Hermes's optional managed-scope overlay;
this deployment already owns the complete configuration file and does not need another overlay.

The release pin supplies defaults for omitted settings. Do not copy the complete upstream defaults into this file.
Only operational choices and contracts belong in the production override. A release change requires checking changed
defaults and consumers, updating schema/version pins, and running production validation. The obsolete `session_reset`
and `memory.flush_min_turns` keys were removed. Disabled code-execution and delegation budget settings were removed too.

The upstream mirror workflow verifies the pinned source, digest, and SLSA attachment. Toolchain publication waits for the
immutable private agent manifest. Kargo then promotes the reviewed source and generated toolchain digest together.
See [README.md](README.md) for delivery and recovery and the
[production rollout runbook](../../../docs/runbooks/hermes-production-rollout.md) for exact operational checks.

## Setting inventory

The table covers every root category in this release's `DEFAULT_CONFIG`. Child settings are defined by the pinned
[source defaults](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/config_defaults.py)
and [example configuration](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/cli-config.yaml.example).
Native consumer keys outside that defaults object, including `platforms`, `platform_toolsets`, and `mcp_servers`, remain
in the production override. An inherited category does not mean that its optional feature is enabled.

This release defines 98 root categories.

| Categories | Production decision |
| --- | --- |
| Model and routing: `model`, `providers`, `fallback_providers`, `fallback`, `credential_pool_strategies`, `model_catalog`, `model_overrides`, `models_dev` | Named local Flamingo provider. No cloud fallback or credential pool is configured. |
| Agent and concurrency: `agent`, `max_concurrent_sessions`, `max_live_sessions`, `session`, `goals`, `loops`, `moa`, `bot_mode`, `delegation` | Explicit coding policy and bounded sessions. Delegation and autonomous orchestration are not exposed. |
| Tools and execution: `toolsets`, `terminal`, `tool_output`, `tool_loop_guardrails`, `file_read_max_chars`, `code_execution`, `tools`, `lsp` | Seven approved toolsets, local terminal, loop guards, and manual language-server installation. |
| Web and browser: `web`, `browser`, `x_search` | Native Exa search and extract. Browser and X tools are not in the enabled toolsets. |
| Context and recall: `compression`, `context`, `context_file_max_chars`, `context_file_read_timeout`, `prompt_caching`, `prefill_messages_file`, `memory`, `sessions`, `database` | Bounded compaction, SQLite WAL, memory, session search, and retained history. |
| Auxiliary tasks: `auxiliary` | Active helpers route to Flamingo. Background review is disabled. Unused task defaults remain inherited. |
| Skills and plugins: `skills`, `curator`, `plugins`, `hooks`, `hooks_auto_accept`, `mcp`, `mcp_discovery_timeout`, `mcp_single_query_discovery_timeout` | Trusted project discovery, security-guidance, no automatic curation, no custom hooks, and no MCP servers. |
| Gateway and channels: `gateway`, `streaming`, `discord`, `slack`, `whatsapp`, `telegram`, `mattermost`, `matrix`, `platform_hints`, `quick_commands`, `human_delay` | One gateway profile. Discord and API are configured; other channels have no credentials or adapter configuration. |
| Dashboard and presentation: `dashboard`, `display`, `personalities`, `paste_collapse_threshold`, `paste_collapse_threshold_fallback`, `paste_collapse_char_threshold` | Private authenticated dashboard, streaming, concise reasoning display, and inherited UI preferences. |
| Voice and images: `tts`, `stt`, `voice`, `vision`, `wake_word` | Speech transcription is disabled. Voice, wake-word, and speech tools are not exposed. Vision helper uses Flamingo. |
| Authority and secrets: `approvals`, `command_allowlist`, `auth`, `security`, `privacy`, `vault`, `secrets` | Manual approvals, fixed deny rules, read-only Kubernetes authority, secret-backed identity, and redaction. |
| Scheduled work: `cron`, `kanban` | Agent scheduling, Kanban dispatch, and decomposition are disabled. Kubernetes owns backups. |
| State and maintenance: `checkpoints`, `runtime`, `logging`, `monitoring`, `telemetry`, `doctor`, `updates`, `timezone`, `_config_version`, `onboarding` | Retained checkpoints and backups, rotating logs, no shared metrics, managed upgrades, and Los Angeles time. |
| Optional integrations: `openrouter`, `bedrock`, `honcho`, `nous`, `vertex`, `local_runtime` | No credentials or local secondary inference service are configured. Release defaults remain inherited. |
| Desktop and networking: `network`, `proxy`, `desktop`, `bot_desktop`, `computer_use` | Kubernetes and Squid own network boundaries. Desktop/computer tools are not exposed. |

## Research sources

- [Hermes configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration/) and the pinned source above define supported settings.
- [Managed scope](https://hermes-agent.nousresearch.com/docs/user-guide/managed-scope) describes native managed-install guards and managed overlays.
- [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), and [plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/) describe the runtime learning and extension boundaries.
- [Web dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard/) documents configuration and authentication behavior.
- [Qwen3.6-35B-A3B model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) supplies the precise coding sampling settings.
- [v2026.9.24 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24) identifies the selected stable upgrade. Development branches are not release candidates for this deployment.
