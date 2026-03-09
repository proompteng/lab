# OpenWebUI Rich Renderer Upgrade For Jangar Chat Completions (2026-03-08)

## Decision

Open Jangar's OpenAI-compatible `POST /openai/v1/chat/completions` streaming path so OpenWebUI can render rich Codex activity without exposing executable tool surface to the browser. The server remains the execution authority.

This design keeps the current markdown/text fallback for all non-OpenWebUI clients and adds an explicit OpenWebUI-only side-channel in `choices[0].delta.jangar_event`.

## References

- OpenWebUI Rich UI docs: `https://docs.openwebui.com/features/extensibility/plugin/development/rich-ui`
- Jangar route: `services/jangar/src/routes/openai/v1/chat/completions.ts`
- Jangar request/stream/state flow: `services/jangar/src/server/chat.ts`
- Current encoder: `services/jangar/src/server/chat-completion-encoder.ts`
- Current fallback tool renderer: `services/jangar/src/server/chat-tool-event-renderer.ts`
- Current tool event decoder: `services/jangar/src/server/chat-tool-event.ts`
- OpenWebUI deployment notes: `docs/jangar/openwebui.md`
- OpenWebUI chat e2e: `services/jangar/tests/openwebui-chat.e2e.ts`
- Canonical Codex stream contract: `packages/codex/src/app-server-client.ts`
- Codex stream tests: `packages/codex/src/app-server-client.events.test.ts`
- Jangar chat-completions tests: `services/jangar/src/server/__tests__/chat-completions.test.ts`
- Jangar encoder tests: `services/jangar/src/server/__tests__/chat-completion-encoder.test.ts`
- OpenWebUI persistence stores: `services/jangar/src/server/chat-thread-store.ts`, `services/jangar/src/server/chat-transcript-store.ts`, `services/jangar/src/server/worktree-store.ts`

## Scope and current implementation baseline

This is a design artifact only; implementation is not present yet.

Current hard constraints:

- OpenWebUI chat already uses the OpenAI-compatible streaming API and forwards `x-openwebui-chat-id`.
- Jangar resolves OpenWebUI clients and keeps thread turn metadata in redis-backed stores.
- `chat.ts` emits SSE keepalive and supports stale thread retry with full transcript replay.
- Current Jangar stream processing emits only OpenAI-standard fields (`content`, `reasoning_content`, `usage`, `error`).
- Current encoder never emits `delta.tool_calls` and tests already assert that behavior.
- Non-stream requests are converted to SSE internally and rebuilt as a JSON completion response in `convertSseToChatCompletionResponse`, so custom SSE fields are dropped by design.
- Stream input contract is `StreamDelta` in `packages/codex/src/app-server-client.ts`, not raw app-server events.
- `StreamDelta.tool` already covers `command`, `file`, `mcp`, `webSearch`, `dynamicTool`, and `imageGeneration`.
- Redis state TTLs for OpenWebUI are `7 days` for thread, transcript, and worktree.

Known mismatch to correct in this design:

- The document must define contracts independent of any current emitter behavior; there is no `jangar_event` yet.
- There is no OpenWebUI-side reducer or persistence model in this repo yet.
- OpenWebUI detail endpoints for render blobs are not present.

## Core goal statement

1. Keep Codex execution on Jangar.
2. Keep default stream compatibility for non-OpenWebUI clients unchanged.
3. Define deterministic OpenWebUI-only structured events, reducers, persistence, and spillover.
4. Ensure deterministic reload/history rendering.
5. Keep rich rendering as native OpenWebUI cards with optional, signed Rich UI detail panes.

## Explicit design constraints

- No browser-owned tool execution.
- No OpenAI `tool_calls` in the stream.
- No `window.args` dependency.
- No attempt to register tools in OpenWebUI.
- `stream: false` always returns non-rich text-first completion.

## Transport gate and feature-gate behavior

Rich renderer only activates when all of these are true:

- Request is streaming (`stream === true`).
- Client is OpenWebUI (`x-openwebui-chat-id` present and `x-jangar-client-kind` resolves to `openwebui`).
- Environment flag `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED === 'true'`.
- Header `x-jangar-openwebui-render-mode: rich-ui-v1` is present.
- Request version is supported (`rich-ui-v1` only in this phase).

Any mismatch returns to legacy behavior for that request.

Non-streaming behavior:

- Must remain content-only with current markdown fallback semantics.
- Unknown fields from SSE are ignored in conversion.
- No persistence of rich metadata for non-streaming requests.

## `jangar_event` contract, schema, and versioning

`jangar_event` is appended to regular OpenAI chunks as an additional key, never replacing standard fields.

### Event envelope (v1)

```ts
export type JangarRenderLane =
  | 'message'
  | 'reasoning'
  | 'plan'
  | 'rate_limits'
  | 'tool'
  | 'usage'
  | 'error'

export type JangarRenderOp = 'append_text' | 'merge' | 'replace' | 'complete'

export type JangarRenderVersion = 'v1'

export type JangarToolKind = 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'

export type JangarEventV1 = {
  version: 'v1'
  mode: 'rich-ui-v1'
  seq: number
  logicalId: string
  lane: JangarRenderLane
  op: JangarRenderOp
  revision: number
  ts: string
  source: {
    method: string
    toolKind?: JangarToolKind
    sourceEventId?: string
  }
  payload: Record<string, unknown>
  preview?: {
    title?: string
    subtitle?: string
    badge?: string
    status?: 'pending' | 'completed' | 'failed'
  }
  renderRef?: {
    id: string
    kind: JangarToolKind | JangarRenderLane
    digest: string
    sizeBytes: number
    expiresAt: string
  }
}
```

`logicalId` is deterministic and stable across retries:

- `assistant:message`
- `assistant:reasoning`
- `assistant:plan:current`
- `assistant:rate-limits`
- `tool:<toolKind>:<id>` where `id` is the upstream tool id.
- `assistant:usage`
- `assistant:error`

Revision rules:

- `seq` increments for every emitted SSE chunk, including no-op/heartbeat chunks.
- `logicalId` carries a reducer-local timeline.
- `revision` increments per logical entity whenever payload shape changes, not for duplicate no-change updates.

Compatibility rules:

- OpenWebUI accepts only `version: 'v1'` and ignores unknown versions.
- Unknown `lane` in v1 is ignored and logged.
- Unknown `op` in v1 must be treated as `merge` if payload is object, otherwise ignore.

Deduplication rules:

- ignore any event with `seq <= lastSeq`.
- ignore any event with `revision <= lastRevisionByLogicalId[logicalId]`.
- accept duplicate `complete` only if new revision.

### `seq` and turn lifecycle

The encoder owns sequence progression per assistant turn.

- `seq` starts at `1` for each assistant turn and increments on every emitted stream chunk.
- `seq` does not reset for retries in the same HTTP response.
- `revision` may be reset to `1` at new turn start.

## Event mapping to lane+op with reducer semantics

Mapping below uses the canonical `StreamDelta` events from `packages/codex/src/app-server-client.ts` and codex notification names where relevant.

### `message`

Source events: `item/agentMessage/delta`.

Structured output:

- `lane: 'message'`
- `logicalId: 'assistant:message'`
- `op: 'append_text'`
- `payload: { summary?: string; previewText: string; textBytes: number }`
- preview contains compact digest for card header only.

Reducer behavior:

- keep reducer and persisted content authoritative as stream `delta.content`.
- `jangar_event` is optional progress metadata only.
- no persistence of duplicate full message text in metadata.

### `reasoning`

Source events: `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`.

Structured output:

- `lane: 'reasoning'`
- `logicalId: 'assistant:reasoning'`
- `op: 'append_text'`
- `payload: { text: string; source: 'summaryTextDelta' | 'textDelta' }`

Reducer behavior:

- append text into `previewText`.
- if `payload.source` indicates full explanation text, set `preview.subtitle` and mark `status='pending'`.
- set `status='completed'` on terminal usage/finish chunk or explicit upstream end.
- trim with boundary-safe truncation to budget (see replay/persistence section).

### `plan`

Source event: `turn/plan/updated`.

Structured output:

- `lane: 'plan'`
- `logicalId: 'assistant:plan:current'`
- `op: 'replace'`
- `payload: { plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>; explanation: string | null }`

Reducer behavior:

- replace entire plan snapshot.
- compute `status` as `completed | in_progress | pending` aggregate for UI summary.

### `rate_limits`

Source event: `account/rateLimits/updated`.

Structured output:

- `lane: 'rate_limits'`
- `logicalId: 'assistant:rate-limits'`
- `op: 'replace'`
- `payload: { planType?: string; primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }; secondary?: {...}; credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string } }`

Reducer behavior:

- replace snapshot on each update.
- keep only most recent `resetsAt` per window and a computed display summary.

### `tool:command`

Source events: `item/started`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/completed`.

Structured output:

- `lane: 'tool'`
- `logicalId: 'tool:command:<toolId>'`
- `op` sequence
  - `merge` for metadata updates and status transitions
  - `append_text` for sanitized output/input previews
  - `complete` on terminal completion
- `payload`:
  - start: `{ status: 'started', title, command, startedAt }`
  - output: `{ status: 'delta', outputPreview, outputLines }`
  - input: `{ status: 'delta', inputPreview }`
  - complete: `{ status: 'completed', exitCode, durationMs, errorCode }`

Reducer behavior:

- merge status/exit metadata and append output/input previews.
- preserve command preview safety by stripping `<details>` reasoning markup before store.
- when preview exceeds budget attach `renderRef` with full transcript.

### `tool:file`

Source events: `item/started`, `item/fileChange/outputDelta`, `item/completed`, `turn/diff/updated`.

Structured output:

- `lane: 'tool'`
- `logicalId: 'tool:file:<toolId>'`
- `op` sequence: `replace` for start/complete, `append_text` or `merge` for incremental diffs
- `payload`: `{ status, title, changedPaths, diffPreviewLines, diffBytes }`

Reducer behavior:

- on start create compact entity with `changedPaths` and zero diff preview.
- on `outputDelta` append sanitized preview with line budget.
- on `turn/diff/updated` store one-time `changedPaths` and one unified-diff summary.
- emit `renderRef` for full diff if truncated.

### `tool:mcp`

Source events: `item/started`, `item/mcpToolCall/progress`, `item/completed`.

Structured output:

- `lane: 'tool'`
- `logicalId: 'tool:mcp:<toolId>'`
- `op`: `merge` for started/progress, `replace` on completion, optional `complete`.
- `payload`: `{ status, toolName, serverName, arguments?: unknown; resultSummary?: string; errorSummary?: string; progressMessage?: string }`

Reducer behavior:

- merge in arguments once and keep a compact result/error summary.
- keep full result/error payload in render blob only when over inline budget.

### `tool:webSearch`

Source events: `item/started`, `item/completed`.

Structured output:

- `lane: 'tool'`
- `logicalId: 'tool:webSearch:<toolId>'`
- `op: 'replace'`
- `payload: { query, status, resultCount?, topHitTitle?, urlCount? }`

Reducer behavior:

- replace each event update.
- avoid storing large body text inline.

### `tool:dynamicTool`

Source events: `item/started`, `item/completed`.

Structured output:

- `lane: 'tool'`
- `logicalId: 'tool:dynamicTool:<toolId>'`
- `op`: `replace`
- `payload: { toolName, status, success?: boolean, arguments?: unknown, contentItems?: unknown[], durationMs?: number }`

Reducer behavior:

- replace entity snapshot per update.
- show compact list in preview with `success` and item counts.

### `tool:imageGeneration`

Source event: `item/completed`.

Structured output:

- `lane: 'tool'`
- `logicalId: 'tool:imageGeneration:<toolId>'`
- `op`: `replace`
- `payload: { revisedPrompt?: string; resultUrl?: string; status: string; width?: number; height?: number; model?: string }`

Reducer behavior:

- replace snapshot with generated image metadata.
- card thumbnail can rely on `resultUrl`.

### `usage`

Source event: `thread/tokenUsage/updated` and final usage frame.

Structured output:

- `lane: 'usage'`
- `logicalId: 'assistant:usage'`
- `op: 'replace'`
- `payload: { input_tokens: number; output_tokens: number; total_tokens: number; cached_tokens?: number; reasoning_tokens?: number }`

Reducer behavior:

- keep latest snapshot only.
- include normalized numbers only; no raw upstream keys.

### `error`

Source events: upstream error notification, Jangar internal normalization, and abort path.

Structured output:

- `lane: 'error'`
- `logicalId: 'assistant:error'`
- `op: 'replace'`
- `payload: { message: string; code: string; type: string; source: 'upstream' | 'jangar' | 'client'; detail?: string }`

Reducer behavior:

- replace terminal error card and mark stream as terminal for that turn in UI state.

## Deterministic replay and compact persistence model

OpenWebUI must persist compact state, not raw SSE events.

### OpenWebUI render state schema

```ts
type JangarRenderEntity = {
  id: string
  lane: JangarRenderLane
  kind?: JangarToolKind | 'assistant'
  revision: number
  status: 'pending' | 'completed' | 'failed'
  lastSeq: number
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
  lastSeq: number
  entities: Record<string, JangarRenderEntity>
  entityOrder: string[]
  lastRevisionByLogicalId: Record<string, number>
  updatedAt: string
  stateHash: string
}
```

Reducer persist rules:

- every accepted event mutates in-memory state and updates `lastSeq`.
- mutation of existing logical entity increments stored revision.
- entity list order is deterministic: stable insertion order, with completed tools sorted by completion timestamp.
- persist full `JangarRenderState` to message metadata at the same cadence as message updates and after stream completion.

Replay determinism:

- reducer replay on reload must be independent of event arrival order beyond `seq` ordering.
- render the same result from persisted state, not from replaying raw SSE chunks.
- render hash in stored state allows cross-check if a stream rebuild diverges.

## Spillover and `renderRef` lifecycle

Payload budgets are mandatory for stability and bounded storage.

Recommended constants:

- `INLINE_PREVIEW_MAX_BYTES_PER_ENTITY = 8192`
- `INLINE_PREVIEW_MAX_TOTAL_BYTES = 131072`
- `COMMAND_OUTPUT_TEXT_MAX_BYTES = 16384`
- `MCP_RESULT_MAX_BYTES = 12288`
- `FILE_DIFF_MAX_LINES = 160`

Spill algorithm:

1. apply delta to entity preview with truncation and byte accounting.
2. if preview exceeds per-entity cap, truncate and set `renderRef`.
3. if total inline grows beyond total cap, stop accepting low-value appends and move additional payload to render blob.
4. maintain preview fallback message `+ truncated` and renderRef metadata.

`renderRef` lifecycle:

- create when first spill needed.
- assign deterministic id from `logicalId` + `seq` + `revision` hash.
- store full payload in Redis blob using canonical JSON.
- keep blob schema versioned and content-type specific.
- attach digest for integrity check.
- TTL and cleanup:
  - blob store TTL is `7 days`.
  - signed URL TTL is `15 minutes`.
  - rendering UI must gracefully degrade if blob has expired.
  - expiry does not invalidate primary compact state.

## Jangar render blob store model

- store namespace: `openwebui:render`
- keys: `${prefix}:${turnId}:${logicalId}` or `${prefix}:${digest}`.
- payload shape:
  - `v`: `1`
  - `kind`: lane/tool kind
  - `createdAt`
  - `expiresAt`
  - `turnId`, `chatId`, `threadId`, `revision`
  - `data`: compact JSON payload, already sanitized.

Security:

- data is for authenticated browser read only through signed endpoints.
- no executable script or unsafe HTML is stored.

## OpenWebUI patch surface and state-reduction model

This section is implementation guidance for the forked OpenWebUI codebase where stream parsing lives.

Required patch surface:

- streaming ingest hook reads `choices[0].delta.jangar_event` without blocking parser.
- typed reducer module that consumes event envelopes in-order by `seq`.
- deterministic `JangarRenderState` serialization into message metadata.
- render pass that maps persisted entities to native cards.
- optional detail-card launcher that requests signed render URLs and displays a sandboxed fallback on failure.

Reducer model:

- keep a single in-memory `OpenWebUIJangarReducerState` per assistant message.
- state fields:
  - `state.version`, `state.lastSeq`, `state.lastRevisionByLogicalId`, `state.entities`, `state.entityOrder`.
- merge policy:
  - if event version is unsupported, record telemetry and skip.
  - if duplicate/older `seq` or `revision`, skip and count duplicate.
  - if accepted, apply op reducer to corresponding entity.
- reducer output is pure data + render flags, never mutates unrelated entities.

UI reduction behavior:

- `command`, `file`, `mcp`, `webSearch`, `dynamicTool`, `imageGeneration` render native cards.
- `usage` and `rate limits` render compact status chips.
- `reasoning`, `plan`, `error` render as assistant rail entries.
- if `renderRef` exists and URL fetch succeeds, card opens a secondary Rich UI detail pane.
- if render URL fails, show summary + `detail unavailable` and keep message card.

## Raw Codex event coverage

V1 intentionally targets normalized `StreamDelta` only.

Current unsupported raw stream surfaces remain unsupported:

- request-user-input.
- collaboration lifecycle events.
- raw response items not in `StreamDelta`.
- split reasoning variants beyond stream mapping.

If these become required, update `packages/codex/src/app-server-client.ts` first and then add schema upgrades in a new contract version.

## Non-streaming fallback, errors, and compatibility

- Non-stream clients receive unchanged OpenAI object with assembled `message.content` and usage.
- Unknown fields are ignored by `convertSseToChatCompletionResponse`; this is preserved.
- OpenWebUI header request for `rich-ui-v1` is ignored in non-streaming mode.
- Any Jangar-side failure in rich event construction must not break legacy fields.

Hard compatibility requirements:

- no regressions for standard OpenAI clients.
- non-OpenWebUI stream parsers must ignore `jangar_event` if present unexpectedly.

## Feature gates and rollout controls

- `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED` toggles server emission globally.
- `JANGAR_OPENWEBUI_RICH_RENDER_MODE_HEADER` (optional) can enforce allowed header values in API gateway layers.
- `JANGAR_OPENWEBUI_RENDER_INLINE_MAX_BYTES` and `JANGAR_OPENWEBUI_RENDER_TOTAL_MAX_BYTES` can be added for runtime tuning.
- when disabled, server emits only standard OpenAI fields.

## Security

- execution stays on Jangar; OpenWebUI receives no tool definitions.
- signed detail endpoints required because OpenWebUI auth can be disabled.
- detail URLs include short-lived signature over `renderId`, `turnId`, `logicalId`, `expiresAt`.
- unsafe escape policy for any displayed output:
  - render as escaped text or JSON.
  - no eval-like content execution.
  - strict CSP for detail HTML.

## Server implementation plan and ownership

### Phase 1: contract + server emit (owner: services/jangar)

- add `JangarRenderEvent` and reducer state structures.
- add render-mode detection in `services/jangar/src/server/chat.ts` and keep defaults off.
- add envelope emission in `services/jangar/src/server/chat-completion-encoder.ts` while preserving existing `content`/`reasoning_content` fallback.
- include only stream path in v1 and keep existing non-stream conversion unchanged.
- add unit tests for emit/no-emit, ordering, revision dedupe, and no-tool-call behavior.

### Phase 2: persistence and spillover (owner: services/jangar)

- add render blob store with TTL and schema (`openwebui:render:*`).
- add helper for digest generation and budget accounting.
- implement `renderRef` creation, expiry, and attachment rules.
- add signed detail endpoint skeleton under `services/jangar/src/server` for future retrieval.
- add tests for overflow, renderRef truncation, and blob metadata validation.

### Phase 3: OpenWebUI fork reducer surface (owner: OpenWebUI fork)

- add `jangar_event` parser and in-memory reducer in stream processing path.
- persist `JangarRenderState` as message metadata.
- add native rail/card renderer with deterministic order.
- add lazy Rich UI detail pane fallback handling.
- add tests for duplicate/older event handling and card rendering.

### Phase 4: end-to-end hardening (owner: OpenWebUI fork + services/jangar)

- add browser e2e against OpenWebUI stream path for each mapped `StreamDelta` kind.
- validate reload determinism against persisted compact metadata.
- wire telemetry and failure dashboards.
- tighten budgets by tuning constants from observability results.

Dependency order:

- phase 1 before phase 2 because spillover depends on emitted metadata shape.
- phase 3 can proceed in parallel with phase 2 only if it consumes a stable contract version.
- phase 4 only after reducer and store semantics are stable.

## Validation plan

### Unit tests

- Encoder tests in `services/jangar/src/server/__tests__/chat-completion-encoder.test.ts`
- Chat routing tests in `services/jangar/src/server/__tests__/chat-completions.test.ts`
- Codex mapping contract tests in `packages/codex/src/app-server-client.events.test.ts`
- optional shared contract tests for lane enums and state hash in `packages/codex` or `services/jangar`

### Integration tests

- converter behavior in `convertSseToChatCompletionResponse` remains content-only for non-stream.
- redis-backed render blob tests for write/read expiry.
- signed URL validation and denial path tests.
- replay tests in OpenWebUI fork for message load and reducer rehydration.

### Browser and e2e validation

- OpenWebUI `playwright` scenarios that send commands for each `StreamDelta` kind and assert visible cards.
- openwebui chat stream rendering tests for rich mode on/off matrix.
- detail pane open/close and same-origin-disabled height autoresize.
- openwebui chat reload test that verifies deterministic card reconstruction from persisted state.

### Replay and reload checks

- capture SSE event sequence for a known turn.
- assert resulting stored `JangarRenderState` hash is stable across two replay passes.
- assert turn-reload render output matches first pass byte-for-byte where UI is normalized.
- assert older `seq`/`revision` events are dropped consistently.

### Backward-compatibility checks

- standard non-openwebui stream clients still render plain content.
- if OpenWebUI sends malformed `jangar_event`, parse path ignores event but continues standard rendering.
- if rich mode header is absent, rich field is never present.
- non-stream requests still produce single JSON completion with no event metadata.

### Operational observability and failure-mode checks

- metrics counters:
  - `jangar_openwebui_rich_render_enabled_total`
  - `jangar_openwebui_rich_event_emitted_total{lane,op}`
  - `jangar_openwebui_rich_event_dropped_total{reason}`
  - `jangar_openwebui_render_blob_created_bytes`
  - `jangar_openwebui_render_blob_expired_total`
  - `jangar_openwebui_render_url_signature_failures_total`
  - `jangar_openwebui_detail_fetch_failures_total`
  - `jangar_openwebui_render_reducer_replay_mismatch_total`
- alert conditions:
  - >5% of streams producing dropped events in successful turns.
  - spike in render blob size + refetch failures.
  - reduced usage of fallback text while rich render flag on.

## Rollout, rollback, and risk

Rollout sequence:

- deploy server-side emission disabled by default with kill switch.
- enable in staging with OpenWebUI fork set to parse+persist but hide cards if renderRef/renderer errors.
- validate with OpenWebUI e2e and a small production canary chat id.
- enable gradually by client header allowlist or namespace.
- monitor SLOs and event mismatch rates before full rollout.

Rollback triggers:

- any spike in parse failures >1% of active OpenWebUI streams.
- any non-openwebui compatibility issue.
- any renderRef fetch storm causing repeated 5xx.

Rollback steps:

- set `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED=false`.
- keep OpenWebUI rich parser in permissive fallback mode for one release.
- clear feature-flagged parser code path in fork if needed.
- clear stale render blob keys by keyspace TTL and ignore cached metadata in frontend.

Risks:

- event contract divergence between Jangar and OpenWebUI reducer.
- preview budget drift causing silent truncation of useful context.
- signature URL leakage if base URL is misconfigured in environments without auth.
- detail endpoint HTML regressions introducing XSS.

Mitigation:

- strict schema versioning and shared contract tests.
- fixed budgets with explicit feature flags.
- short-lived URL signatures and nonce rotation.
- CSP + markdown escapes + no inline user script in HTML templates.

## Exit criteria

- `jangar_event` v1 is fully specified and test-covered.
- reducer semantics are deterministic and replayable from persisted compact metadata.
- compact state and spillover behavior are bounded and explicit.
- detail URL security and expiry model is implemented in a fork-and-fork-safe manner.
- non-OpenWebUI clients are unchanged and remain compatible.
- rollout has clear gating and rollback for failures.
