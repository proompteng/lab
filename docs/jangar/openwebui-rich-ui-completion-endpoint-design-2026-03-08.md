# OpenWebUI Rich Renderer Upgrade For Jangar Chat Completions (2026-03-08)

## Decision

Jangar’s `POST /openai/v1/chat/completions` streaming response should support a dedicated OpenWebUI-only side-band `jangar_event` contract carried on `choices[0].delta.jangar_event` so OpenWebUI can render richer Codex activity cards and tool cards.

Execution authority remains 100% in Jangar/Jangar’s backend. No browser-owned execution and no migration to OpenAI `tool_calls`.

Plain OpenAI-compatible completion behavior remains the default and must stay unchanged for non-OpenWebUI clients.

## Production objective for this design

- Make `jangar_event` deterministic, versioned, and replay-safe.
- Define strict lane semantics for message, reasoning, plan, rate-limit, tool, usage, and error activity.
- Define compact persistence contracts for stream rebuild determinism and spillover rendering.
- Enable OpenWebUI incremental parsing/reduction and offline reload determinism without replaying raw SSE.
- Preserve compatibility for streaming and non-stream callers today.

## Current implementation baseline (verified)

- Streaming request shape in `services/jangar/src/server/chat.ts` only requires `stream: true` in parsed body; non-stream requests are proxied by injecting `stream: true` and `stream_options.include_usage: true`.
- OpenWebUI identity resolution is based on
  - `x-openwebui-chat-id` (fallback client kind `openwebui`) and
  - `x-jangar-client-kind` when set.
- The exact precedence in `resolveChatClientKind` is explicit:
  - `trade-execution` and `discord` are routed via explicit values.
  - `x-jangar-client-kind: openwebui` maps to `openwebui`.
  - If an unknown non-empty `x-jangar-client-kind` is present, client kind becomes `unknown` even if `x-openwebui-chat-id` is present.
  - If no client-kind header is set and `x-openwebui-chat-id` is present, client kind becomes `openwebui`.
- `ChatCompletionEncoder` currently emits only standard OpenAI chunk fields and legacy markdown for plan/rate-limits.
- Tool and reasoning sanitizer behavior is already implemented in
  - `services/jangar/src/server/chat-completion-encoder.ts`
  - `services/jangar/src/server/chat-tool-event-renderer.ts`
- `convertSseToChatCompletionResponse` already collapses SSE into JSON by reading `data:` frames and preserving only `choices[].delta.message.content` and usage.

## Scope constraints

- This design stays server-execution-authoritative.
- No browser-owned tool execution, no tool sandbox handoff, and no OpenAI `tool_calls` surface.
- No schema changes in `~/.openai` external interfaces are assumed.
- This design is for production readiness of the OpenWebUI rich UI stream and metadata contracts; no OpenWebUI runtime code in this repository is assumed.

## Transport gates and non-stream fallback

### Baseline today

1. Jangar must receive a stream request.
2. `chat.ts` currently treats any openwebui-class client (`openwebui`/`discord`) as eligible for stateful chat behavior.

### Target rich rendering activation (Phase 1)

Rich UI emission for a request is active only if:

- request is stream.
- client is OpenWebUI by current baseline classification (`resolveChatClientKind === 'openwebui'` and not overridden to `unknown` by a non-empty explicit client-kind header).
- `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED === 'true'`.
- optional header gate `x-jangar-openwebui-render-mode === 'rich-ui-v1'` is enabled.
- optional chat allowlist `JANGAR_OPENWEBUI_RICH_ALLOWED_CHAT_IDS` contains the value of `x-openwebui-chat-id`.

If any condition fails, behavior remains legacy-only:

- no `jangar_event` emission.
- stream content continues to be OpenAI standard only (`content`, `reasoning_content`, legacy markdown).
- non-openwebui clients are unaffected.

### Non-stream fallback

`runChatCompletionWithModeSupport` always proxy-converts to a streaming internal request. The final conversion in `convertSseToChatCompletionResponse` ignores any `jangar_event` payloads and unknown frame keys.

The non-stream path preserves:

- response object schema.
- `message.content`.
- optional usage.

The non-stream path ignores:

- `thread_id` and `turn_number`.
- inline reason content except where surfaced in text.
- any custom metadata fields.

## `jangar_event` contract

### Envelope schema and versioning

```ts
export type JangarRenderLane = 'message' | 'reasoning' | 'plan' | 'rate_limits' | 'tool' | 'usage' | 'error'

export type JangarRenderOp = 'append_text' | 'merge' | 'replace' | 'complete'

export type JangarRenderVersion = 'v1'

export type JangarRenderEventSource = {
  method: string // upstream notification/method used by Codex
  toolKind?: 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'
  sourceEventId?: string
}

export type JangarPreview = {
  title?: string
  subtitle?: string
  badge?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export type JangarRenderRef = {
  id: string
  kind: 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'
  digest: string
  sizeBytes: number
  expiresAt: string
}

export type JangarEventV1 = {
  version: JangarRenderVersion
  mode: 'rich-ui-v1'
  seq: number // monotonic stream position within assistant turn
  logicalId: string // deterministic by lane+entity
  lane: JangarRenderLane
  op: JangarRenderOp
  revision: number // per logicalId monotonic mutation counter
  ts: string // RFC3339 UTC
  source: JangarRenderEventSource
  payload: Record<string, unknown>
  preview?: JangarPreview
  renderRef?: JangarRenderRef
}
```

### Deterministic IDs and ordering

- `logicalId` formats:
  - `assistant:message`
  - `assistant:reasoning`
  - `assistant:plan`
  - `assistant:rate-limits`
  - `assistant:usage`
  - `assistant:error`
  - `tool:${toolKind}:${toolId}`
- `seq` is local to one assistant turn and starts at `1`.
- `revision` increments only when reducer state changes for the logical entity.
- `seq` and `revision` are independent; both must be validated.

### Compatibility and drop rules

- only `version: 'v1'` is accepted.
- Unknown `lane` is dropped.
- Unknown `op` handling is
  - treat as `merge` for object-like payloads.
  - ignore if payload is scalar.
- drop events when:
  - `seq <= lastSeq`
  - `revision <= lastRevisionByLogicalId[logicalId]`

## Source mapping and lane contracts

Source mapping references actual Codex stream outputs in `packages/codex/src/app-server-client.ts` and current Jangar adapters.

### lane `message`

- source: `StreamDelta.type === 'message'`
- source notifications: `item/agentMessage/delta`
- logicalId: `assistant:message`
- op: `append_text`
- payload: `{ text: string }`
- reducer: append `text`, output compact text for display.

### lane `reasoning`

- source: `StreamDelta.type === 'reasoning'`
- source notifications: `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`
- logicalId: `assistant:reasoning`
- op: `append_text`
- payload: `{ text: string; source?: 'summaryTextDelta' | 'textDelta' }`
- reducer: append text.

### lane `plan`

- source: `StreamDelta.type === 'plan'`
- source notification: `turn/plan/updated`
- logicalId: `assistant:plan`
- op: `replace`
- payload: `{ explanation: string | null; plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> }`
- reducer: replace entire plan snapshot and recompute aggregate status.

### lane `rate_limits`

- source: `StreamDelta.type === 'rate_limits'`
- source notification: `account/rateLimits/updated`
- logicalId: `assistant:rate-limits`
- op: `replace`
- payload: `RateLimitSnapshot` compact shape
  - `planType?: string`
  - `primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }`
  - `secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }`
  - `credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string }`
- reducer: update only when snapshot diff is meaningful and publish latest value.

### lane `tool`

- source: `StreamDelta.type === 'tool'`
- source event `toolKind` mapping:
  - `command` from `commandExecution`
    - started/completed: `item/started`, `item/completed`
    - output: `item/commandExecution/outputDelta`
    - terminal input: `item/commandExecution/terminalInteraction`
    - op strategy: `merge` / `append_text` / `complete`
    - logicalId: `tool:command:<toolId>`
  - `file` from `fileChange`
    - started/completed: `item/started`, `item/completed`
    - output: `item/fileChange/outputDelta`
    - diff updates: `turn/diff/updated`
    - op strategy: `replace` / `append_text` / `merge`
    - logicalId: `tool:file:<toolId>`
  - `mcp` from `mcpToolCall`
    - started/completed: `item/started`, `item/completed`
    - progress: `item/mcpToolCall/progress`
    - op strategy: `merge` / `replace`
    - logicalId: `tool:mcp:<toolId>`
  - `webSearch` from `webSearch`
    - started/completed: `item/started`, `item/completed`
    - logicalId: `tool:webSearch:<toolId>`
    - op: `replace`
  - `dynamicTool` from `dynamicToolCall`
    - started/completed: `item/started`, `item/completed`
    - logicalId: `tool:dynamicTool:<toolId>`
    - op: `replace`
  - `imageGeneration` from `imageGeneration`
    - started/completed: `item/completed` in current stream shape
    - logicalId: `tool:imageGeneration:<toolId>`
    - op: `replace`

For all tool lanes:

- payloads remain compact and UI-safe.
- large fields should be shifted into `renderRef` only after spill.
- command output sanitizer from existing stream behavior (`stripReasoningDetails`) is applied before reducer state update.

### lane `usage`

- source: `StreamDelta.type === 'usage'`
- source notifications: `thread/tokenUsage/updated`
- logicalId: `assistant:usage`
- op: `replace`
- payload: `{ input_tokens?: number; output_tokens?: number; total_tokens?: number; cached_tokens?: number; reasoning_tokens?: number }`
- reducer: keep latest compact normalized totals.

### lane `error`

- source: `StreamDelta.type === 'error'` plus internal errors from `onInternalError`
- logicalId: `assistant:error`
- op: `replace`
- payload: `{ message: string; code: string; type: string; source: 'upstream' | 'jangar' | 'client'; detail?: string }`
- reducer: terminal error row; visible but should not crash stream.

## Replay state model

### In-memory UI state model (OpenWebUI)

```ts
type OpenWebUIJangarReducerState = {
  version: 'v1'
  mode: 'rich-ui-v1'
  lastSeq: number
  lastRevisionByLogicalId: Record<string, number>
  entities: Record<string, JangarRenderEntity>
  entityOrder: string[]
}
```

### Persisted compact replay state schema

```ts
type JangarRenderEntity = {
  id: string
  lane: JangarRenderLane
  kind: JangarRenderLane | 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'
  logicalId: string
  revision: number
  seq: number
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  payload: Record<string, unknown>
  preview: Record<string, unknown>
  renderRef?: {
    id: string
    kind: string
    digest: string
    sizeBytes: number
    expiresAt: string
  }
  createdAt: string
  updatedAt: string
}

type JangarRenderState = {
  version: 'v1'
  mode: 'rich-ui-v1'
  turnId: string
  chatId?: string
  threadId?: string
  laneOrder: string[]
  lastSeq: number
  lastRevisionByLogicalId: Record<string, number>
  entities: Record<string, JangarRenderEntity>
  entityOrder: string[]
  stateHash: string
  updatedAt: string
}
```

### Replay and persistence invariants

- Persist snapshot only for assistant message completion.
- Deterministic state assembly order:
  - sort non-tool lanes as `message`, `reasoning`, `plan`, `rate_limits`, `usage`, `error`.
  - maintain first-seen order for tool entities.
  - append terminal-complete items in `seq` order.
- `stateHash` is a deterministic digest of stable JSON over:
  - `version`, `mode`, `laneOrder`, `lastSeq`, `entityOrder`, and each entity (`payload`, `preview`, `status`, `renderRef.id`, `revision`).
- Reload logic:
  - verify `version === 'v1'` and parseable hash.
  - if malformed/old/mismatch, discard and rebuild from persisted inline lane history only.

## Spillover and `renderRef` lifecycle

Budget constants:

- `INLINE_PREVIEW_MAX_BYTES_PER_ENTITY = 8192`
- `INLINE_PREVIEW_MAX_TOTAL_BYTES = 131072`
- `COMMAND_OUTPUT_TEXT_MAX_BYTES = 16384`
- `FILE_DIFF_MAX_LINES = 160`
- `MCP_RESULT_MAX_BYTES = 12288`
- `SPILLOVER_THRESHOLD_PCT = 85`

Behavior:

1. apply incoming event delta to the target entity state.
2. if entity exceeds per-entity cap, create or update `renderRef` and truncate preview.
3. if total inline payload exceeds total cap, mark lower-priority entities for compact summaries.
4. always keep reducer state acceptance and revision bump for truncated events.
5. set preview `subtitle = '+ truncated'` when spillover has occurred.

RenderRef semantics:

- `id` is stable per logical state and revision with `sha256(`${logicalId}:${revision}:${version}`).slice(0, 24)`.
- Jangar stores spillover payload by signed URL key.
- Jangar config defaults:
  - blob TTL = 7 days
  - signed fetch TTL = 15 minutes
- On missing/expired render data:
  - show `detail unavailable` and continue with inline state.
  - keep stream/replay flow usable.

## OpenWebUI patch surface and state-reduction model

### Parser + reducer responsibilities

- parse `choices[0].delta.jangar_event` from each incoming stream chunk.
- validate shape minimally with fast-path fallback:
  - unknown/invalid events are dropped and counted.
  - unknown version/lane/op are ignored.
- dedupe by `(logicalId, seq, revision)`.
- maintain one reducer state per assistant message.
- apply deterministic operations to `JangarRenderLane` entities.

### Persistence responsibilities

- persist compact `JangarRenderState` in message metadata (or equivalent attachment point in OpenWebUI message history).
- persist only compact payload, never full raw SSE.
- persist `stateHash` beside payload.

### Renderer responsibilities

- add dedicated rich cards for tool entities.
- keep reasoning/plan/rate/usage/error compact rail items.
- render inline text and lazy-load `renderRef` data.
- fail safe: if rendering fails, keep legacy content visible.

## Non-stream and compatibility behavior

- for stream `false`, API response path remains JSON completion.
- for stream-converted (`runChatCompletionWithModeSupport`) path, non-stream assembly continues to ignore all `jangar_event` fields.
- unknown `jangar_event` is never fatal.
- legacy clients receiving `jangar_event` should continue to function as before:
  - no `tool_calls` emission.
  - plain assistant content and optional usage remain canonical.

## Feature gates

- `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED` (boolean, default `false`) is master feature gate.
- `JANGAR_OPENWEBUI_RENDER_MODE_HEADER` optional regex/allowlist for accepted `x-jangar-openwebui-render-mode` values.
- `JANGAR_OPENWEBUI_RICH_ALLOWED_CHAT_IDS` optional comma-separated allowlist.
- `JANGAR_OPENWEBUI_RENDER_INLINE_MAX_BYTES`, `JANGAR_OPENWEBUI_RENDER_TOTAL_MAX_BYTES` runtime tuning overrides.

## Security model

- no executable payload sent to OpenWebUI.
- all rendered content must be escaped/sanitized.
- signed render URL scope must bind at least:
  - `renderRef.id`
  - `turnId`
  - `logicalId`
  - request window expiry
- short TTL by default and no long-lived browser caching of render content.

## Implementation plan (phased, with ownership and dependency order)

### Phase 1a — server contract and stream events in Jangar

Owners:

- `services/jangar/src/server/chat-completion-encoder.ts`
- `services/jangar/src/server/chat.ts`

Tasks:

- implement v1 schema and deterministic `jangar_event` emission.
- add render-mode detection and env/headers gates.
- add reducer-facing metadata (`seq`, `revision`, `logicalId`, `lane`, `op`, `source`).
- keep existing OpenAI behavior untouched by default.

Dependencies:

- must be complete before persistence + OpenWebUI reducer work.

### Phase 1b — spillover and persistence primitives

Owners:

- `services/jangar/src/server/chat-completion-encoder.ts`
- optional new helper under `services/jangar/src/server`.

Tasks:

- deterministic compact snapshot/stateHash helper.
- spillover calculations and preview truncation rules.
- signed render reference metadata generation.

Dependencies:

- requires Phase 1a schema contracts.

### Phase 2 — OpenWebUI fork integration

Owners:

- external OpenWebUI stream parser/reducer/render components.

Tasks:

- add `jangar_event` parse and reducer state.
- persist compact `JangarRenderState` on assistant message completion.
- render cards + rails and lazy `renderRef` fetch.

Dependencies:

- final payload contract from Phase 1 must be final.

### Phase 3 — validation hardening and rollout

Owners:

- `services/jangar` tests and `docs/jangar/...`.

Tasks:

- add end-to-end stream contract tests.
- add determinism and backward-compatibility assertions.
- add operational dashboard instrumentation.

Dependency order:

- Phase 1a before 1b.
- Phase 2 requires locked v1 payload contract.
- Phase 3 requires all prior phase completion.

## Validation plan

### Unit tests

- add/extend `services/jangar/src/server/__tests__/chat-completion-encoder.test.ts` for:
  - sequence/revision emission.
  - malformed tool event handling.
  - plan/rate-limit suppression semantics.
- add/extend stream contract tests under `services/jangar/src/server/__tests__/chat-completions.test.ts` for:
  - openwebui mode detection with header/header precedence.
  - feature-gate on/off behavior.
  - non-stream compatibility when streaming conversion is used.

### Integration checks

- unit-level integration for reducer/state helper and `stateHash` verification.
- non-stream conversion test proving `choices[].delta.jangar_event` never appears in JSON output.
- stale-thread replay and transcript append behavior unaffected by feature flags.

### Replay and reload determinism

- capture stream event sequence for one turn with tool and plan updates.
- build persisted state from sequence and verify rebuild output determinism across two replay passes.
- verify malformed/missing persisted state falls back to inline-only render without stream breakage.

### Browser-level e2e matrix (`services/jangar/tests/openwebui-chat.e2e.ts`)

- verify non-rich and rich mode toggle path.
- validate stream frame parsing doesn’t break existing OpenWebUI chat flow.
- render card presence for command/file/mcp/webSearch lanes when rich mode is enabled.
- verify renderRef missing/expired fallback path.

### Backward-compatibility checks

- non-openwebui clients should not break with stream false and stream true.
- confirm `tool_calls` remains empty/absent for existing test coverage.
- malformed/unknown `jangar_event` is ignored.

### Observability + failure mode checks

Required metrics:

- `jangar_openwebui_rich_event_emitted_total{lane,op}`
- `jangar_openwebui_rich_event_dropped_total{reason}`
- `jangar_openwebui_rich_event_parse_fail_total`
- `jangar_openwebui_render_blob_created_bytes`
- `jangar_openwebui_render_blob_expired_total`
- `jangar_openwebui_render_url_signature_failures_total`
- `jangar_openwebui_render_fetch_fail_total`
- `jangar_openwebui_replay_mismatch_total`

Alerting baseline:

- > 5% dropped events over 5-minute window.
- repeated render fetch failures while stream usage remains healthy.
- replay mismatch rate increasing in staged rollout.

## Rollout, rollback, and risk

### Rollout

1. land design-complete implementation with rich mode disabled by default.
2. enable on canary OpenWebUI chat IDs.
3. monitor metrics + e2e for regression.
4. expand to more IDs when pass criteria are met.

### Rollback

- disable `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED`.
- gate parser to legacy-only rendering.
- invalidate persisted state snapshots if schema mismatch is observed.

### Key risks and mitigations

- contract drift:
  - mitigate with shared fixtures and matrix tests between Jangar and OpenWebUI.
- spillover data loss:
  - tune budgets and keep concise previews visible.
- parser/runtime overhead:
  - optimize reducer and reject invalid events quickly.
- signed URL abuse:
  - short TTL and scoped signature keys.

## Exit criteria

- `jangar_event` v1 contract is complete, deterministic, and validated.
- reducer semantics are specified by lane and operation.
- compact persistence and replay are defined with deterministic hash checks.
- spillover/renderRef lifecycle and TTL behavior are actionable.
- validation plan includes unit, integration, replay determinism, and fallback checks.
- rollout/rollback criteria are concrete for production.
