# OpenWebUI Rich Renderer Upgrade For Jangar Chat Completions (2026-03-08)

## Decision

Jangar’s `POST /openai/v1/chat/completions` streaming path should emit a dedicated OpenWebUI side-band event in
`choices[0].delta.jangar_event` so OpenWebUI can render rich, non-executable cards for Codex activity. Jangar keeps all execution authority; the browser never owns tool execution.

Execution behavior for non-OpenWebUI clients remains unchanged and plain OpenAI-compatible streaming text is still the default.

## References

- OpenWebUI Rich UI docs: `https://docs.openwebui.com/features/extensibility/plugin/development/rich-ui`
- Jangar route: `services/jangar/src/routes/openai/v1/chat/completions.ts`
- Jangar request/stream/state flow: `services/jangar/src/server/chat.ts`
- Streaming encoder: `services/jangar/src/server/chat-completion-encoder.ts`
- Legacy tool renderer: `services/jangar/src/server/chat-tool-event-renderer.ts`
- Tool event decoder: `services/jangar/src/server/chat-tool-event.ts`
- OpenWebUI deployment notes: `docs/jangar/openwebui.md`
- OpenWebUI chat e2e: `services/jangar/tests/openwebui-chat.e2e.ts`
- Canonical Codex stream contract: `packages/codex/src/app-server-client.ts`
- Codex stream tests: `packages/codex/src/app-server-client.events.test.ts`
- Jangar completion tests: `services/jangar/src/server/__tests__/chat-completions.test.ts`
- Jangar encoder tests: `services/jangar/src/server/__tests__/chat-completion-encoder.test.ts`
- OpenWebUI persistence stores: `services/jangar/src/server/chat-thread-store.ts`, `services/jangar/src/server/chat-transcript-store.ts`, `services/jangar/src/server/worktree-store.ts`

## Scope and current implementation baseline

### Confirmed hard constraints from current code

- OpenWebUI clients send `x-openwebui-chat-id`; `resolveChatClientKind` maps this to `openwebui`.
- Streaming path is produced only by `handleChatCompletionEffect` via `toSseResponse`; it sets `text/event-stream` and emits keepalive frames.
- Non-stream requests are proxied through the same streaming handler by:
  - `runChatCompletionWithModeSupport` cloning request
  - forcing `stream: true`
  - forcing `stream_options.include_usage: true`
  - converting SSE frames in `convertSseToChatCompletionResponse`
- Current encoder emits only OpenAI-standard fields in `delta` (`content`, `reasoning_content`), `choices[].usage`, and `error`.
- No `tool_calls` are emitted today.
- `ChatCompletionStreamSession` currently treats:
  - `plan` via markdown conversion (`**Plan**` and todo list)
  - `rate_limits` as one-time markdown block
  - `error` by terminalizing and dropping subsequent non-usage stream deltas.
- Existing non-stream conversion is content-only:
  - `parseSseFrames` parses only `data:` lines
  - only `delta.content`, `message.content`, and usage counters are preserved.

### Gaps this design closes

- Define a versioned, deterministic payload contract for OpenWebUI (`jangar_event`) that is independent from current renderer behavior.
- Define lane-by-lane reducer operations and persistence semantics.
- Specify spillover (`renderRef`) lifecycle and deterministic replay storage.
- Define OpenWebUI parsing/reduction patch points and non-stream fallback expectations.

## Explicit constraints

- Jangar remains the only execution authority.
- OpenWebUI never triggers/executes tools from the emitted contract.
- No `window.args` dependency.
- No tool registration from Jangar into OpenWebUI.
- `stream: false` responses remain plain completion JSON.

## Transport and feature gates

Rich mode is active only when all conditions below are true:

- Streaming request.
- Client is OpenWebUI:
  - `x-openwebui-chat-id` present, and/or
  - `x-jangar-client-kind === 'openwebui'`
- `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED === 'true'`
- Header `x-jangar-openwebui-render-mode === 'rich-ui-v1'`
- Optional allowlist guard (if configured): `JANGAR_OPENWEBUI_RICH_ALLOWED_CHAT_IDS` contains chat id

If any check fails, Jangar behaves exactly as today.

### Non-stream fallback behavior

- Jangar’s proxy path (`runChatCompletionWithModeSupport`) always emits a synthetic `stream: true` request and then converts SSE to JSON.
- In conversion, non-open fields inside chunks, including `thread_id`, `turn_number`, unknown delta keys, and `jangar_event`, are ignored.
- Therefore non-stream clients are guaranteed text-first responses with optional `usage` and no rich metadata.

### Stream mode behavior when rich rendering is active

- Existing OpenAI fields are preserved verbatim for compatibility.
- `jangar_event` is additive and appears on any delta chunk.
- Unknown/invalid `jangar_event` must be ignored by downstream clients.

## `jangar_event` contract (v1)

`jangar_event` is a side-band object emitted in `choices[0].delta.jangar_event`.

### Envelope schema

```ts
type JangarRenderLane = 'message' | 'reasoning' | 'plan' | 'rate_limits' | 'tool' | 'usage' | 'error'

type JangarRenderOp = 'append_text' | 'merge' | 'replace' | 'complete'

type JangarRenderVersion = 'v1'

type JangarEventSource = {
  method: string // upstream notification/method correlation
  toolKind?: 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'
  sourceEventId?: string // upstream event id, if available
}

type JangarPreview = {
  title?: string
  subtitle?: string
  badge?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
}

type JangarRenderRef = {
  id: string
  kind: JangarRenderLane | 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'
  digest: string
  sizeBytes: number
  expiresAt: string // RFC 3339 UTC
}

type JangarEventV1 = {
  version: JangarRenderVersion
  mode: 'rich-ui-v1'
  seq: number // monotonically increments per assistant turn
  logicalId: string // deterministic by lane/entity
  lane: JangarRenderLane
  op: JangarRenderOp
  revision: number // per logicalId, monotonically changes on state mutation
  ts: string // RFC 3339 UTC
  source: JangarEventSource
  payload: Record<string, unknown>
  preview?: JangarPreview
  renderRef?: JangarRenderRef
}
```

### Deterministic IDs and sequencing

- `logicalId` formats:
  - `assistant:message`
  - `assistant:reasoning`
  - `assistant:plan:current`
  - `assistant:rate-limits`
  - `assistant:usage`
  - `assistant:error`
  - `tool:<toolKind>:<toolId>`
- `seq` is incremented for every emitted `jangar_event` (no gaps required, start at `1`).
- `revision` is bumped only when reducer state changes for that logical entity.

### Compatibility and dedupe

- OpenWebUI must accept only `version: 'v1'`; unknown versions are ignored and logged.
- Unknown `lane` values are ignored.
- Unknown `op` values in `v1` are treated as:
  - `merge` when payload is object,
  - ignore when payload is primitive.
- Dedup/drop rule:
  - ignore `seq <= lastSeq`
  - ignore if `revision <= lastRevisionByLogicalId[logicalId]`
  - allow repeated `complete` only if revision increases
- Replay determinism rule: reduction is driven by persisted state only (see below), not re-parsing raw SSE history.

## Lane mapping and reducer semantics (v1)

For each lane, Jangar emits deterministic reducer deltas and OpenWebUI reducer consumes by `seq` order.

### Shared source contract

Canonical source stream is `StreamDelta` from `packages/codex/src/app-server-client.ts`.

### Lane: `message`

- Source: `StreamDelta.type === 'message'`
- Upstream context: regular `item/agentMessage/delta`
- `logicalId`: `assistant:message`
- `op`: `append_text`
- `payload`: `{ text: string }`

Reducer:

- Append `text` to entity `payload.text`.
- Keep reducer output as the canonical stream message text.
- OpenWebUI should ignore duplicates based on `revision`.

### Lane: `reasoning`

- Source: `StreamDelta.type === 'reasoning'`
- Upstream context: `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`
- `logicalId`: `assistant:reasoning`
- `op`: `append_text`
- `payload`: `{ text: string; source?: 'summaryTextDelta' | 'textDelta' }`

Reducer:

- Append text to `payload.text`.
- If `source === 'summaryTextDelta'`, mark summary completion candidate in preview (`preview.subtitle`).
- On terminal usage/finalization set status `completed`.

### Lane: `plan`

- Source: `StreamDelta.type === 'plan'`
- Upstream context: `turn/plan/updated`
- `logicalId`: `assistant:plan:current`
- `op`: `replace`
- `payload`: `{ explanation: string | null; plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> }`

Reducer:

- Replace full plan snapshot.
- Compute aggregate `status` as `completed | in_progress | pending`.
- Preserve compact list only; no large nested objects.

### Lane: `rate_limits`

- Source: `StreamDelta.type === 'rate_limits'`
- Upstream context: `account/rateLimits/updated`
- `logicalId`: `assistant:rate-limits`
- `op`: `replace`
- `payload`:

  ```ts
  {
    planType?: string
    primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }
    secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }
    credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string }
  }
  ```

Reducer:

- Replace snapshot when any value changes.
- Keep only latest `resetsAt` and compact summary per window.

### Lane: `tool` for command

- Source: `StreamDelta.type === 'tool'` and `toolKind === 'command'`
- Upstream context:
  - `item/started` (`type === 'commandExecution'`)
  - `item/commandExecution/outputDelta`
  - `item/commandExecution/terminalInteraction`
  - `item/completed` (`type === 'commandExecution'`)
- `logicalId`: `tool:command:<toolId>`
- `op` sequence:
  - `merge` for metadata/status
  - `append_text` for output/input previews
  - `complete` on completion
- `payload`:

  ```ts
  {
    status: 'started' | 'delta' | 'completed'
    command?: string
    title?: string
    outputPreview?: string
    outputLines?: number
    inputPreview?: string
    exitCode?: number
    durationMs?: number
    errorCode?: string
    errorMessage?: string
  }
  ```

Reducer:

- Preserve existing sanitizer behavior (strip `<details type="reasoning">...` from command output).
- Collapse duplicate command deltas by `revision`.
- If output grows over budget, create `renderRef`.

### Lane: `tool` for file

- Source: `StreamDelta.type === 'tool'` and `toolKind === 'file'`
- Upstream context:
  - `item/started` (`type === 'fileChange'`)
  - `item/fileChange/outputDelta`
  - `item/completed` (`type === 'fileChange'`)
  - synthetic `turn/diff/updated` snapshot
- `logicalId`: `tool:file:<toolId>`
- `op` sequence:
  - `replace` for started/completed snapshots
  - `append_text` for delta previews
  - `merge` for metadata updates
- `payload`: `{ status?: string; title?: string; changedPaths?: string[]; diffLines?: number; diffPreviewLines?: string[] }`

Reducer:

- Create compact entity on started.
- On diff updates, append sanitized preview and count lines.
- On completion, mark terminal status and final summary.

### Lane: `tool` for mcp

- Source: `StreamDelta.type === 'tool'` and `toolKind === 'mcp'`
- Upstream context:
  - `item/started` (`type === 'mcpToolCall'`)
  - `item/mcpToolCall/progress`
  - `item/completed` (`type === 'mcpToolCall'`)
- `logicalId`: `tool:mcp:<toolId>`
- `op` sequence:
  - `merge` for started/progress
  - `replace` for completion snapshot
  - optional `complete` for terminal metadata
- `payload`: `{ toolName?: string; serverName?: string; status: string; arguments?: unknown; resultSummary?: string; errorSummary?: string; progressMessage?: string }`

Reducer:

- Keep latest argument/result summary compactly.
- Send large result/error payloads to `renderRef`.

### Lane: `tool` for webSearch

- Source: `StreamDelta.type === 'tool'` and `toolKind === 'webSearch'`
- Upstream context: `item/started`, `item/completed`
- `logicalId`: `tool:webSearch:<toolId>`
- `op`: `replace`
- `payload`: `{ status: string; query?: string; resultCount?: number; topHitTitle?: string; urlCount?: number }`

Reducer:

- Replace full card summary each event.
- Do not include large search result payload inline.

### Lane: `tool` for dynamicTool

- Source: `StreamDelta.type === 'tool'` and `toolKind === 'dynamicTool'`
- Upstream context: `item/started`/`item/completed` (`type === 'dynamicToolCall'`)
- `logicalId`: `tool:dynamicTool:<toolId>`
- `op`: `replace`
- `payload`: `{ status: string; toolName?: string; success?: boolean; arguments?: unknown; contentItems?: unknown[]; durationMs?: number }`

Reducer:

- Replace snapshot on each meaningful event.
- Use compact item counts and status summary in preview.

### Lane: `tool` for imageGeneration

- Source: `StreamDelta.type === 'tool'` and `toolKind === 'imageGeneration'`
- Upstream context: `item/completed` (`type === 'imageGeneration'`)
- `logicalId`: `tool:imageGeneration:<toolId>`
- `op`: `replace`
- `payload`: `{ status: string; revisedPrompt?: string; resultUrl?: string; width?: number; height?: number; model?: string }`

Reducer:

- Replace snapshot and render compact card summary.
- Thumbnail uses `resultUrl` when available.

### Lane: `usage`

- Source: `StreamDelta.type === 'usage'`, final `session.finalize` usage chunk
- Upstream context: `thread/tokenUsage/updated`
- `logicalId`: `assistant:usage`
- `op`: `replace`
- `payload`: `{ input_tokens: number; output_tokens: number; total_tokens: number; cached_tokens?: number; reasoning_tokens?: number }`

Reducer:

- Keep latest normalized usage counts only.
- Store as compact totals.

### Lane: `error`

- Source: `StreamDelta.type === 'error'` and internal errors from encoder finalizer/abort
- `logicalId`: `assistant:error`
- `op`: `replace`
- `payload`: `{ message: string; code: string; type: string; source: 'upstream' | 'jangar' | 'client'; detail?: string }`

Reducer:

- Replace terminal error entry.
- Surface error card and mark stream terminal state.

## Deterministic replayable persistence format

OpenWebUI must persist a compact serialized state per assistant message and rehydrate UI from this state, never from raw event streams.

### Persisted state schema

```ts
type JangarRenderEntity = {
  id: string
  lane: JangarRenderLane
  kind?: JangarRenderLane | 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'
  logicalId: string
  revision: number
  seq: number
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  payload: Record<string, unknown>
  preview: Record<string, unknown>
  renderRef?: JangarRenderRef
  createdAt: string
  updatedAt: string
}

type JangarRenderState = {
  version: 'v1'
  mode: 'rich-ui-v1'
  turnId: string
  chatId?: string
  threadId?: string
  laneOrder: string[] // deterministic render order
  lastSeq: number
  lastRevisionByLogicalId: Record<string, number>
  entities: Record<string, JangarRenderEntity>
  entityOrder: string[] // stable ordering of entities by lifecycle rules
  stateHash: string // deterministic hash for rebuild verification
  updatedAt: string
}
```

### Reducer persist rules

- State updates occur on every accepted `jangar_event`.
- `laneOrder` baseline for non-tool lanes is fixed: `message`, `reasoning`, `plan`, `rate_limits`, `usage`, `error`.
- Tool entities preserve first-seen ordering; terminal completion appends to end in `seq` order.
- On turn finalization, state is stored as persisted metadata only for the assistant message that carries the final usage/finish event.
- On load/reload:
  - load stored `JangarRenderState`
  - verify `version === 'v1'` and `stateHash`
  - if malformed/old version, discard and rebuild from available inline history; this is not a hard failure.

### Hash and integrity

- `stateHash` is computed over stable-json serialization of:
  - `version`, `mode`, `lastSeq`, `entityOrder`, and each entity (`payload`, `preview`, `status`, `renderRef.id`, `revision`).
- Any mismatch on reload triggers a replay mismatch metric and fallback to rebuild.

## Spillover and `renderRef` lifecycle

### Limits

- `INLINE_PREVIEW_MAX_BYTES_PER_ENTITY = 8192`
- `INLINE_PREVIEW_MAX_TOTAL_BYTES = 131072`
- `COMMAND_OUTPUT_TEXT_MAX_BYTES = 16384`
- `FILE_DIFF_MAX_LINES = 160`
- `MCP_RESULT_MAX_BYTES = 12288`
- `SPILLOVER_THRESHOLD_PCT = 85`

### Spill algorithm

1. Apply update to entity payload/preview.
2. If entity exceeds inline max, truncate to boundary-safe boundaries and create/update `renderRef`.
3. If total inline bytes exceed total budget, mark low-priority event classes as truncated and keep only summary preview.
4. Preserve event acceptance and revision bumps even when spillover occurs.
5. Emit `preview.subtitle = '+ truncated'` in UI when spillover occurred.

### `renderRef` lifecycle

- `renderRef` is created when truncation is required.
- id is stable across logical revisions: `sha256(`${logicalId}:${revision}:${version}`).slice(0, 24)`.
- Stored payloads are full canonical JSON for that logical entity under a Jangar-side blob key.
- Jangar stores signed URL metadata in response/event with short-lived validity.
- Jangar blob TTL: `7 days`.
- Signed render URL TTL: `15 minutes`.
- If blob has expired or cannot be fetched:
  - render `detail unavailable`
  - keep inline state and continue rendering.

## OpenWebUI patch surface and reduction model

### Required patch surface in OpenWebUI fork

- Stream parser path:
  - read `choices[0].delta.jangar_event`
  - ignore malformed events and continue normal rendering
- Reducer module:
  - sort/consume events by `(seq, lane, logicalId)` in arrival-safe order
  - apply dedupe rules (`seq`, `revision`)
- State persistence:
  - store compact `JangarRenderState` in message metadata on assistant message completion
  - version under `v1`
  - include `stateHash`
- Renderer:
  - native card components for tool lanes
  - rail entries for reasoning/rate/plan
  - usage/error status chips
- RenderRef integration:
  - request signed URL when card opens
  - sandboxed display of blob content
  - fallback on failure without breaking stream

### State-reduction model details

OpenWebUI keeps one in-memory state object per assistant message:

```
type OpenWebUIJangarReducerState = {
  version: 'v1'
  mode: 'rich-ui-v1'
  lastSeq: number
  lastRevisionByLogicalId: Record<string, number>
  entities: Record<string, JangarRenderEntity>
  entityOrder: string[]
}
```

Apply operations:

- unknown versions/layers are ignored
- out-of-order duplicates by seq/revision are dropped and counted
- accepted events run deterministic reducer transitions
- outputs remain pure data; do not mutate unrelated entities

## Non-stream and compatibility model

- `stream:false` and all non-OpenWebUI requests continue as plain completion with legacy fields.
- Unknown `jangar_event` in compatible clients must be ignored.
- If rich-header is supplied but gates are not met, no `jangar_event` is emitted.
- Existing tests for plain path (`chat-completion-encoder.test.ts`, `chat-completions.test.ts`) should remain green.

## Feature-gates and rollout controls

- `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED` (boolean, default `false`) gates emission.
- `JANGAR_OPENWEBUI_RICH_RENDER_MODE_HEADER` (optional static allowlist of allowed header values).
- `JANGAR_OPENWEBUI_RENDER_INLINE_MAX_BYTES` / `JANGAR_OPENWEBUI_RENDER_TOTAL_MAX_BYTES` for emergency tuning.
- `JANGAR_OPENWEBUI_RICH_RENDER_MODE_HEADER` should be used in shared gateway/proxy if needed for phased enablement.

## Security and safety

- No executable tool payload is delivered to OpenWebUI.
- All rich cards are text-first and must escape potentially unsafe values.
- Signed render URLs required; Jangar signs `{renderId, turnId, logicalId, exp}` with current secret.
- Signed URL scope is restricted to:
  - `renderRef.id`
  - request turn/chat context
  - digest/expiry binding
- CSP and sandboxing for rich detail content.
- Never cache render payloads in browser beyond UI component lifecycle.

## Phase plan, ownership, and dependency order

### Phase 1 (services/jangar): contract + stream emission

- Add shared schema/type definitions for `jangarEvent` in `services/jangar/src/server`.
- Add render-mode detection and global feature flag checks in `chat.ts`.
- Extend encoder `onDelta` and lifecycle (`finalize`) to emit v1 events while preserving existing `content`/`reasoning_content` behavior.
- Ensure `include_plan` behavior still suppresses plan deltas.
- Add unit tests for:
  - gate miss/no event
  - valid `jangar_event` emission sequence
  - no regressions in existing markdown fallback

### Phase 2 (services/jangar): spillover + blob + signature

- Add deterministic `JangarRenderState` reducer in Jangar for local tests and optional state snapshot.
- Add spillover and signed blob endpoint:
  - `openwebui:render:*` keyspace
  - digest + expiry metadata + verification
- Add renderRef lifecycle tests:
  - truncation thresholds
  - TTL enforcement
  - missing/expired blob fallback

### Phase 3 (OpenWebUI fork): parser + reducer + renderer

- Add `jangar_event` parser and reducer state in stream path.
- Persist compact `JangarRenderState` to message metadata.
- Add native card and rail renderers.
- Add renderRef lazy loading and fallback on errors.

### Phase 4 (cross-stack hardening)

- Add browser e2e coverage for lane coverage and reload determinism.
- Add metrics and dashboards.
- Add backward-compatibility tests for non-openwebui/legacy clients.

Dependency order:

- Phase 1 before phase 2.
- OpenWebUI phase 3 blocked until `version: v1` and envelope schema is stable.
- Phase 4 requires phases 1–3 and stable release gates.

## Validation plan

### Unit tests

- Add encoder-level tests in `services/jangar/src/server/__tests__/chat-completion-encoder.test.ts` for:
  - v1 event emission per lane
  - seq/revision monotonicity
  - dedupe behavior
  - include_plan=false suppression
- Extend `services/jangar/src/server/__tests__/chat-completions.test.ts`:
  - openwebui-mode detection
  - feature-gate off path
  - malformed stream metadata fallback
- Add contract schema tests for render state in dedicated shared test file (e.g., `services/jangar/src/server/__tests__/jangar-render-contract.test.ts`).

### Integration and conversion checks

- `convertSseToChatCompletionResponse` keeps JSON content-only behavior in non-stream mode.
- Non-stream test paths continue to return `message.content`, optional `usage`, and no `jangar_event`.
- Redis-side tests for blob persistence and `renderRef` expiry.

### Browser / e2e

- Extend `services/jangar/tests/openwebui-chat.e2e.ts` for:
  - rich-mode on/off matrix
  - `command`, `file`, `mcp`, and `web search` tool event visibility in cards
  - detail-pane open + missing URL fallback behavior
- Add replay determinism scenario:
  - capture stream sequence
  - assert persisted hash is stable across two renders
  - assert byte-for-byte normalised UI output match on reload

### Backward-compatibility checks

- Plain OpenAI stream clients ignore new field and render unchanged output.
- Invalid `jangar_event` should not break assistant content or usage emission.
- header-only requests from OpenWebUI clients with legacy path stay plain.

### Observability and failure modes

Required metrics:

- `jangar_openwebui_rich_event_emitted_total{lane,op}`
- `jangar_openwebui_rich_event_dropped_total{reason}`
- `jangar_openwebui_rich_event_parse_fail_total`
- `jangar_openwebui_render_blob_created_bytes`
- `jangar_openwebui_render_blob_expired_total`
- `jangar_openwebui_render_url_signature_failures_total`
- `jangar_openwebui_render_fetch_fail_total`
- `jangar_openwebui_replay_mismatch_total`

Alert thresholds:

- > 5% dropped events in successful turns.
- render blob size growth with rising fetch failures.
- repeated fallback-to-text rate after rich mode is enabled.

## Rollout, rollback, and risk

### Rollout

1. Merge implementation with Jangar-rich mode disabled by default.
2. Enable in staging + staged OpenWebUI parser.
3. Canary production clients by header allowlist/chat id allowlist.
4. Expand to broader traffic if replay determinism and metrics pass.
5. Promote to default in a second flagged rollout.

### Rollback

Immediate rollback if:

- parse failures > 1% of active OpenWebUI streams.
- non-openwebui behavior regression.
- sustained detail-fetch 5xx loops.

Rollback steps:

- set `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED=false`
- force renderer permissive fallback mode in OpenWebUI
- optionally clear stale render blobs by TTL and ignore persisted compact state if needed.

### Risks and mitigations

- Contract drift between emitter and reducer:
  - strict schema checks and shared test vectors
- Aggressive truncation dropping useful context:
  - conservative default budgets, adjustable env tuning
- Signature leakage:
  - short-lived signatures and per-request binding
- Detail rendering XSS:
  - strict escaping, no inline script, sandbox and CSP

## Exit criteria

- `jangar_event` v1 is fully specified, versioned, and tested.
- Deterministic reducer + persisted compact state semantics are defined and validated for replay.
- Spillover and `renderRef` boundaries are explicit, bounded, and enforced.
- Render endpoint security model is explicit with expiry and signed access.
- Backward compatibility for standard OpenAI clients is preserved.
- Rollout and rollback mechanics are explicit enough for production release.
