# Agents Shell Effect Schema Modularization Plan

## Goal

Execute the agents-shell refactor end to end on branch `codex/agents-shell-effect-module`:

- Document the plan.
- Refactor `agents-shell` into a real module under `services/agents/src/server/agents-shell/`.
- Fully migrate agents-shell tool contracts from Zod to Effect Schema with no fallback.
- Preserve existing MCP behavior, tool names, OAuth behavior, workspace safety, audit logging, timeout behavior, output shapes, and process semantics.
- Add regression coverage for the Effect Schema adapter, no-fallback boundary, module boundary, and existing critical behavior.
- Run focused tests, typecheck, and lint.
- Open a ready PR titled `refactor(agents): modularize agents-shell effect schemas`.
- Address review and CI, squash merge when green, and verify the result is published to `main`.

## Summary

`services/agents/src/server/agents-shell-mcp.ts` will become a thin compatibility entrypoint. It should only re-export existing public names and start the server when invoked by `start:agents-shell`. Schemas, tools, auth, request handling, process execution, path policy, audit logging, and JSON-schema conversion will move into `services/agents/src/server/agents-shell/`.

The migration is behavior-preserving. The only intended user-facing change is clearer timeout guidance in tool descriptions and `agent_guide`.

## Key Changes

- Create `services/agents/src/server/agents-shell/` as the owning module.
- Keep `agents-shell-mcp.ts` under 150 lines and free of schema, tool, and runner implementation.
- Do not use MCP SDK `registerTool` for agents-shell tools because it validates through Zod internally.
- Install `tools/list` and `tools/call` directly on the underlying MCP server with a local Effect Schema backed registry.
- Define one internal `EffectTool` contract with name, metadata, input schema, optional output schema, scopes, annotations, and an Effect handler.
- Use `effect`, `effect/Schema`, `effect/JSONSchema`, and `effect/ParseResult` only. Do not add `@effect/platform`.
- Remove agents-shell imports of `zod`, `zod-compat`, and `zod-json-schema-compat`.
- Preserve compact ChatGPT-facing schemas: no `$schema`, no output schemas in discovery, `additionalProperties: false`, no artificial maximums for timeout/output caps, and total tool-list JSON under 18 KB.
- Keep Node `spawn` process semantics. Do not replace the process runner with `@effect/platform/Command`.

## Module Layout

- `index.ts`: public barrel for existing exported symbols.
- `server.ts`: `createAgentsShellServer`.
- `http.ts`: request handler and startup helpers.
- `config.ts`: env/default config parsing.
- `auth.ts`: OAuth metadata, scope checks, bearer challenge, identity allowlist.
- `schemas.ts`: all Effect Schema input/output contracts and inferred types.
- `mcp-adapter.ts`: low-level `tools/list` and `tools/call` handlers backed by Effect Schema.
- `json-schema.ts`: Effect Schema to ChatGPT-facing JSON schema sanitizer.
- `results.ts`: structured/text result helpers and output validation.
- `errors.ts`: typed Effect/Data errors and MCP error mapping.
- `workspace-policy.ts`: path/cwd allowlist helpers.
- `audit.ts`: best-effort JSONL audit writer.
- `process-runner.ts`: foreground process execution.
- `jobs.ts`: background shell job store, output tails, status, kill, timeout.
- `cli-policy.ts`: readonly/mutating `git` and `kubectl` argv policy.
- `agent-run.ts`: delegated AgentRun manifest/build/read/cancel helpers.
- `tools/`: grouped tool definitions for guide, file/search, patch, shell, git, kubectl, and delegated-agent tools.

## Compatibility Requirements

Existing exports from `agents-shell-mcp.ts` must remain available:

- `AgentsShellRunner`
- `buildBearerChallenge`
- `createAgentsShellRequestHandler`
- `createAgentsShellServer`
- `defaultAgentsShellConfigFromEnv`
- `normalizeMcpAcceptHeader`
- `oauthIdentityAllowed`
- `oauthProtectedResourceMetadata`
- `resolveWorkspacePath`
- `startAgentsShellServer`
- `AgentsShellConfig`
- `AuthContext`

Existing MCP tool names and wire behavior must remain unchanged:

- `search`
- `read_file`
- `apply_patch`
- `agent_guide`
- `shell_run`
- `shell_start`
- `shell_read`
- `shell_kill`
- `shell_status`
- `git`
- `git_write`
- `kubectl`
- `kubectl_admin`
- `agent_start`
- `agent_status`
- `agent_read`
- `agent_cancel`

Structured content keys must remain compatible with current tests.

## Timeout Requirements

- Runtime default remains `AGENTS_SHELL_DEFAULT_TIMEOUT_SECONDS=60`.
- Runtime max remains `AGENTS_SHELL_MAX_TIMEOUT_SECONDS=1800`.
- `timeoutSeconds` descriptions must say: `Timeout in seconds. Default: 60. Server cap: 1800.`
- `maxOutputBytes` descriptions must state the configured default and server cap.
- `agent_guide` must state the default timeout, server timeout cap, and that long work should use `shell_start/read/status/kill`.

## Process Requirements

- Preserve `/bin/bash -lc` for shell tools.
- Preserve detached process groups for background jobs.
- Preserve retained stdout/stderr tails and byte offsets.
- Preserve process-group `SIGTERM` for background timeout/kill.
- Foreground timeout must kill the child and return a normal `ProcessResult` with `timedOut: true`.
- Background jobs remain intentionally longer-lived than a single tool call and are managed by `ShellJobStore`.

## Implementation Sequence

1. Start from fresh `origin/main` on branch `codex/agents-shell-effect-module`.
2. Move code mechanically into modules while preserving behavior.
3. Add the Effect tool registry and low-level MCP adapter.
4. Convert all agents-shell schemas to Effect Schema.
5. Convert handlers to Effect while preserving existing business logic and error messages where tests depend on them.
6. Tighten timeout docs and `agent_guide`.
7. Clean final module boundaries so no giant replacement file remains.

## Test Plan

Baseline behavior:

```bash
bun run --filter @proompteng/agents test -- src/server/agents-shell-mcp.test.ts
```

Add coverage for:

- `tools/list` serialized size stays below 18 KB.
- no `$schema` in input schemas.
- no output schemas exposed in discovery.
- `additionalProperties: false` on object schemas.
- no `maximum` on `timeoutSeconds` or `maxOutputBytes`.
- timeout/output descriptions include default and cap.
- invalid input returns a readable Effect Schema parse error.
- agents-shell implementation files do not import `zod`, `zod-compat`, or `zod-json-schema-compat`.
- `agents-shell-mcp.ts` has no schema/tool implementation and stays under 150 lines.
- OAuth missing-scope still returns `mcp/www_authenticate`.
- ordinary tool failure still does not return OAuth reconnect metadata.
- path traversal/cwd safety still blocks.
- `apply_patch` still validates Codex patch syntax and path scope.
- foreground command timeout still returns `timedOut: true`.
- background `shell_start` timeout still marks job `timed_out` and kills process group.
- git descendant-stdio test still returns quickly.
- readonly `git` and `kubectl` policy still blocks mutating commands while write/admin tools still allow intended commands.
- delegated AgentRun helpers still build the same manifest shape.

Final validation:

```bash
bun run --filter @proompteng/agents test -- src/server/agents-shell-mcp.test.ts
bun run --filter @proompteng/agents tsc
bunx oxfmt --check services/agents/src/server/agents-shell services/agents/src/server/agents-shell-mcp.ts services/agents/src/server/agents-shell-mcp.test.ts
bun run --filter @proompteng/agents lint:oxlint
```

## Defaults

- No tool names, MCP routes, OAuth scopes, or external wire shapes change.
- No direct deploy or cluster mutation is part of this refactor.
- No new dependency is added.
- Audit logging remains best effort.
- PR title: `refactor(agents): modularize agents-shell effect schemas`.
