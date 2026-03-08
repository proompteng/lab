# OpenWebUI Rich Renderer Upgrade For Jangar Chat Completions (2026-03-08)

## Decision

Upgrade Jangar's OpenAI-compatible `POST /openai/v1/chat/completions` endpoint so OpenWebUI can render Codex activity as display-only UI without registering Codex tools in OpenWebUI and without exposing executable tools to the browser.

The production design is:

1. Keep Codex execution fully owned by Jangar.
2. Preserve the current text-first OpenAI-compatible SSE stream for every client.
3. Add an OpenWebUI-only structured SSE extension: `choices[0].delta.jangar_event`.
4. Patch OpenWebUI to reduce those events into compact, persisted message metadata and render native activity cards.
5. Use OpenWebUI Rich UI iframe patterns only for drill-down/detail views, not for every streamed event.

This design is deliberately not "fake native tool calls". Jangar remains the only execution authority. OpenWebUI becomes a viewer with a richer renderer.

## References

- OpenWebUI Rich UI docs:
  - `https://docs.openwebui.com/features/extensibility/plugin/development/rich-ui`
- Jangar route:
  - `services/jangar/src/routes/openai/v1/chat/completions.ts`
- Jangar request/stream/state flow:
  - `services/jangar/src/server/chat.ts`
- Current encoder:
  - `services/jangar/src/server/chat-completion-encoder.ts`
- Current fallback tool renderer:
  - `services/jangar/src/server/chat-tool-event-renderer.ts`
- Current tool event decoder:
  - `services/jangar/src/server/chat-tool-event.ts`
- Current OpenWebUI deployment notes:
  - `docs/jangar/openwebui.md`
- OpenWebUI chat e2e:
  - `services/jangar/tests/openwebui-chat.e2e.ts`
- Canonical Codex stream contract:
  - `packages/codex/src/app-server-client.ts`
- Codex stream tests:
  - `packages/codex/src/app-server-client.events.test.ts`
- Jangar chat-completions tests:
  - `services/jangar/src/server/__tests__/chat-completions.test.ts`
- Jangar encoder tests:
  - `services/jangar/src/server/__tests__/chat-completion-encoder.test.ts`
- Jangar chat state stores:
  - `services/jangar/src/server/chat-thread-store.ts`
  - `services/jangar/src/server/chat-transcript-store.ts`
  - `services/jangar/src/server/worktree-store.ts`

## Current Implementation Facts

These are hard constraints from the current code, not assumptions:

- OpenWebUI already uses the OpenAI-compatible streaming path and forwards `x-openwebui-chat-id`.
- Jangar treats OpenWebUI specially in `chat.ts`:
  - immediate SSE keepalive is emitted to avoid client-side aborts during Codex startup
  - OpenWebUI chat state is persisted as thread id, turn number, transcript signature, and worktree name
  - stale upstream thread ids are retried by clearing stored state and replaying the full transcript
- Stateful OpenWebUI conversation data currently has a 7-day TTL in Redis:
  - thread: `THREAD_TTL_SECONDS`
  - transcript: `TRANSCRIPT_TTL_SECONDS`
  - worktree: `WORKTREE_TTL_SECONDS`
- The current encoder intentionally flattens rich activity into text:
  - `message` -> `delta.content`
  - `reasoning` -> `delta.reasoning_content`
  - `plan` -> markdown checklist
  - `rate_limits` -> markdown blockquote
  - `tool` -> fenced text and summaries
  - `usage` -> usage chunk
  - `error` -> error payload
- Jangar explicitly does not emit `delta.tool_calls`, and tests assert that.
- The current normalized Codex stream contract is `StreamDelta`, not raw app-server `EventMsg`.
- `StreamDelta` currently includes:
  - `message`
  - `reasoning`
  - `plan`
  - `rate_limits`
  - `tool`
  - `usage`
  - `error`
- `tool` currently covers these upstream tool kinds:
  - `command`
  - `file`
  - `mcp`
  - `webSearch`
  - `dynamicTool`
  - `imageGeneration`
- The current non-streaming compatibility path in `chat.ts` converts SSE back into a single chat-completion response and discards unknown delta fields.

Those facts drive the design below.

## Problem

OpenWebUI needs structured rendering for Codex activity, but the unsafe options are ruled out:

- Do not register Codex tools in OpenWebUI.
- Do not emit OpenAI `tool_calls`.
- Do not let the browser call Codex-owned tools.
- Do not rely on internal OpenWebUI native tool rendering behavior.

At the same time, the current markdown fallback is not enough for production UX:

- command output is readable but not structured
- `dynamicTool` and `imageGeneration` are not first-class UI targets
- MCP args/result/error are text blobs, not inspectable state
- reload/history persistence for rich activity is undefined
- large outputs/diffs/results would explode message size if naively shoved into metadata

## Goals

- Keep Jangar as the only execution authority for Codex tools.
- Keep the current fallback stream fully valid for non-OpenWebUI clients.
- Give OpenWebUI a structured render path for every current `StreamDelta` variant.
- Persist enough render state that reload/history remain deterministic.
- Keep the primary renderer cheap and native to the OpenWebUI fork.
- Use Rich UI embeds for detail panes that benefit from sandboxed HTML/iframe rendering.
- Bound payload size and define spillover behavior explicitly.

## Non-Goals

- Switching OpenWebUI to native tool execution for Codex.
- Rendering the full raw Codex `EventMsg` superset in v1.
- Making non-streaming chat completions return Rich UI metadata.
- Building iframes for every delta or every card.
- Depending on `window.args`, native tool result placement, or OpenWebUI action execution.

## Key Design Choice

The first draft overused Rich UI iframes. That is not the right production shape.

The production split is:

- Primary renderer:
  - OpenWebUI native custom cards rendered from compact message metadata
- Secondary renderer:
  - sandboxed Rich UI iframes for heavy detail views like full diffs, large MCP results, long command transcripts, or image previews

Why:

- rendering every streamed delta in an iframe is expensive
- current Rich UI docs are best suited to embedded detail views, not high-frequency stream state
- native cards are easier to persist and replay from chat history
- detail iframes still let us follow the Rich UI contract when richer HTML is actually useful

## Transport Contract

### Render mode gating

Rich rendering is enabled only when all of these are true:

- client resolves to `openwebui`
- request is streaming
- Jangar rich-render feature flag is on
- request or deployment opts into `rich-ui-v1`

Suggested controls:

- env: `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED=true|false`
- env: `JANGAR_OPENWEBUI_EXTERNAL_BASE_URL=http://jangar`
- request header: `x-jangar-openwebui-render-mode: rich-ui-v1`

`rich-ui-v1` is streaming-only. The current non-stream compatibility path drops unknown delta fields, so v1 must not pretend otherwise.

### SSE extension field

When rich mode is on, Jangar adds one structured field to normal OpenAI chunks:

```json
{
  "choices": [
    {
      "delta": {
        "content": "",
        "jangar_event": { "...": "..." }
      }
    }
  ]
}
```

Normal fallback fields remain unchanged:

- `delta.content`
- `delta.reasoning_content`
- `usage`
- `error`

### Event envelope

The event envelope must be explicit enough to support dedupe, replay, and compaction.

```ts
type JangarRenderEvent = {
  version: 'v1'
  seq: number
  logicalId: string
  revision: number
  lane: 'message' | 'reasoning' | 'plan' | 'rate_limits' | 'tool' | 'usage' | 'error'
  op: 'append_text' | 'merge' | 'replace' | 'complete'
  payload: Record<string, unknown>
  preview?: {
    title?: string
    subtitle?: string
    badge?: string
  }
  renderRef?: {
    id: string
    kind: string
    expiresAt: string
  }
}
```

Rules:

- `seq`:
  - monotonically increasing per assistant turn, starting at `1`
- `logicalId`:
  - stable reducer key
  - examples:
    - `message:assistant`
    - `reasoning:summary`
    - `plan:current`
    - `rate_limits:current`
    - `tool:cmd-1`
    - `tool:mcp-1`
    - `usage:final`
    - `error:current`
- `revision`:
  - monotonically increasing per `logicalId`
  - lets the reducer ignore stale or repeated snapshots even if transport retries happen
- `op`:
  - `append_text` for append-only text streams
  - `merge` for partial structured updates
  - `replace` for full snapshot replacement
  - `complete` to mark the entity terminal

The OpenWebUI reducer must ignore:

- any event with `seq <= lastSeq`
- any event for a `logicalId` with `revision <= lastRevision[logicalId]`

## Event Mapping And Merge Semantics

The reducer behavior must be deterministic and cheap.

### `message`

- Source:
  - `item/agentMessage/delta`
- Fallback:
  - `delta.content`
- Structured render:
  - optional lightweight progress entity only
- Persistence:
  - do not duplicate full assistant text inside rich metadata
  - authoritative text remains the normal message content

### `reasoning`

- Source:
  - `item/reasoning/textDelta`
  - `item/reasoning/summaryTextDelta`
- Fallback:
  - `delta.reasoning_content`
- Structured render:
  - `append_text` into `logicalId=reasoning:summary`
- Persistence:
  - store a bounded preview in compact state
  - spill full detail to `renderRef` when large

### `plan`

- Source:
  - `turn/plan/updated`
- Fallback:
  - markdown checklist
- Structured render:
  - `replace` snapshot on `logicalId=plan:current`

### `rate_limits`

- Source:
  - `account/rateLimits/updated`
- Fallback:
  - markdown blockquote
- Structured render:
  - `replace` snapshot on `logicalId=rate_limits:current`

### `tool:command`

- Source:
  - `item/started`
  - `item/commandExecution/outputDelta`
  - `item/commandExecution/terminalInteraction`
  - `item/completed`
- Fallback:
  - existing fenced output in `chat-tool-event-renderer.ts`
- Structured render:
  - `merge` snapshot for command title/status/exitCode/duration
  - `append_text` for stdout/stderr preview
  - `append_text` for stdin preview
  - `complete` on terminal state
- Sanitization:
  - reuse current reasoning-details stripping behavior before preview persistence
- Spillover:
  - full transcript goes to `renderRef` when preview budget is exceeded

### `tool:file`

- Source:
  - `item/started`
  - `item/fileChange/outputDelta`
  - `item/completed`
  - `turn/diff/updated`
- Fallback:
  - fenced diff/text
- Structured render:
  - `replace` or `merge` summary snapshot
  - inline preview stores changed paths and truncated diffs only
  - full unified diff goes to `renderRef`

### `tool:mcp`

- Source:
  - `item/started`
  - `item/mcpToolCall/progress`
  - `item/completed`
- Fallback:
  - current plain-text JSON sections
- Structured render:
  - `merge` status, args, result, error, progress message
  - inline preview stores compact result summary only
  - full result/error payload spills to `renderRef` when large

### `tool:webSearch`

- Source:
  - `item/started`
  - `item/completed`
- Fallback:
  - query shown as inline code
- Structured render:
  - `replace` snapshot with query and status

### `tool:dynamicTool`

- Source:
  - `item/started`
  - `item/completed`
- Structured render:
  - `replace` snapshot with tool name, arguments, success, content items, duration
- Notes:
  - this is first-class in v1
  - current fallback remains text-only

### `tool:imageGeneration`

- Source:
  - `item/completed`
- Structured render:
  - `replace` snapshot with revised prompt and result URL
- Notes:
  - inline preview can show prompt and thumbnail URL
  - full viewer can use Rich UI detail pane

### `usage`

- Source:
  - `thread/tokenUsage/updated`
  - final usage chunk already emitted by the encoder
- Structured render:
  - replace `usage:final` with the latest normalized usage snapshot

### `error`

- Source:
  - upstream error notification
  - Jangar internal error path
  - client abort path
- Structured render:
  - replace `error:current`
  - mark turn state terminal

## OpenWebUI Data Model

Do not persist the raw event stream as the primary format.

Persist compacted render state on the assistant message:

```ts
type JangarRenderState = {
  version: 'v1'
  mode: 'rich-ui-v1'
  lastSeq: number
  entities: Record<string, unknown>
  entityOrder: string[]
  updatedAt: string
}
```

Rules:

- the reducer updates `JangarRenderState` in memory as SSE arrives
- OpenWebUI persists compacted state, not the full append-only event log
- optional debug-only raw event capture may exist behind a feature flag, but it is not the main persistence format

Why:

- command output can emit many deltas
- raw event persistence makes reload and DB growth worse
- the chat history only needs the reduced display state

## Payload Budget And Spillover

This is required for production quality.

Suggested limits:

- max inline preview per entity:
  - `8 KiB` textual preview
- max total inline rich metadata per assistant message:
  - `128 KiB`
- anything beyond the inline budget:
  - store a compact preview inline
  - spill the full snapshot to Redis as a render blob
  - attach `renderRef`

Suggested render blob store:

- key prefix:
  - `openwebui:render`
- TTL:
  - `7 days`, matching existing OpenWebUI thread/transcript/worktree state

The inline state must remain usable even when the render blob expires. Expiration should degrade detail views, not the main activity cards.

## Rich UI Detail Views

Use the OpenWebUI Rich UI iframe model for detail views only.

Examples:

- full command transcript
- full MCP result/error inspector
- full unified diff viewer
- image generation preview
- long reasoning trace

### Jangar detail endpoints

Add browser-reachable Jangar endpoints such as:

- `GET /api/openwebui/rich-ui/render/:renderId`

Response requirements:

- `Content-Type: text/html; charset=utf-8`
- `Content-Disposition: inline`
- `Cache-Control: no-store`
- `Access-Control-Expose-Headers: Content-Disposition`

### Browser reachability

OpenWebUI currently talks to Jangar's in-cluster OpenAI URL server-to-server, but iframe/detail fetches must use a browser-reachable Jangar base URL.

Add:

- `JANGAR_OPENWEBUI_EXTERNAL_BASE_URL`

Examples:

- `http://jangar`
- `http://jangar.ide-newton.ts.net`

### Height reporting

Rich UI docs make this explicit:

- same-origin iframe access is off by default
- therefore every Jangar detail HTML page must report height with `postMessage`
- every page must include the `iframe:height` reporting script and a `ResizeObserver`

Do not rely on same-origin access being enabled in user settings.

### Placement

Rich UI docs distinguish native tool embeds vs action/message embeds. This integration is neither. In our OpenWebUI fork, rich detail panes should render as message-level embeds below the assistant bubble or within the activity rail expansion area.

Do not try to piggyback on native tool-result placement.

## Security Model

### Execution safety

- OpenWebUI never receives executable Codex tool definitions.
- Rich UI endpoints are read-only renderers.
- Browser JavaScript never invokes Codex tools directly.

### Signed render URLs

Because current OpenWebUI auth is disabled and the browser may fetch detail URLs directly, render URLs must be signed.

Recommended shape:

- `renderId`
- `expiresAt`
- HMAC signature over `renderId`, `expiresAt`, and a stable message-scoped salt

Rules:

- default URL lifetime:
  - `15 minutes`
- render blob TTL:
  - `7 days`
- expired or invalid signatures return a safe error page, not raw data

### HTML safety

- never inject raw tool output as HTML
- serialize tool output into escaped text or JSON
- only Jangar-owned templates produce HTML
- detail templates should use a restrictive CSP tailored to the assets they need

### Cross-frame communication

- only `postMessage` is required by default
- do not depend on parent DOM access
- do not depend on `window.args`
  - that is for native tool embeds, which this design intentionally avoids

## Jangar Server Changes

### `chat.ts`

- add render-mode selection
- pass render mode into the encoder
- only attach `jangar_event` for OpenWebUI rich mode
- keep current heartbeat, stale-thread retry, transcript reconciliation, and stateless fallback behavior unchanged
- do not change non-streaming behavior in v1 beyond preserving fallback text

### `chat-completion-encoder.ts`

- keep existing fallback emission logic
- add a parallel structured-event emission path
- own the `seq` counter
- emit normalized `jangar_event` envelopes
- externalize oversize payloads into render blobs

### New render blob store

- Redis-backed
- 7-day TTL
- stores large snapshots for render refs

### New Rich UI render endpoints

- serve signed, inline HTML detail views
- reusable templates by entity kind

## OpenWebUI Fork Changes

### Streaming ingest

- detect `choices[0].delta.jangar_event`
- apply reducer immediately to in-flight assistant message state
- ignore duplicate or stale `seq`/`revision`

### Persistence

- persist compact `JangarRenderState` on the assistant message
- do not persist the raw event stream by default

### Rendering

- render a native activity rail from compact state
- cards:
  - command
  - file
  - MCP
  - web search
  - dynamic tool
  - image generation
  - reasoning
  - plan
  - rate limits
  - usage
  - error
- each card may optionally open a Rich UI detail pane if `renderRef` exists

### Failure handling

- if detail fetch fails:
  - keep the compact card visible
  - show "detail unavailable" instead of collapsing the whole UI
- if rich renderer is disabled:
  - fallback text remains fully readable

## Raw Codex Event Coverage

The Codex app-server emits a larger raw event surface than Jangar currently exposes. That raw superset lives under `packages/codex/src/app-server/EventMsg.ts`.

This v1 design intentionally targets the current normalized `StreamDelta` contract because that is what Jangar's completion endpoint actually receives today.

If we later want to render raw events like:

- request-user-input
- collab lifecycle
- raw response items
- plan deltas beyond the current normalized plan snapshot
- reasoning content/raw-content variants

then the first change must happen in `packages/codex/src/app-server-client.ts`, not in the OpenWebUI renderer.

## Observability

Add counters/logging for:

- rich render mode enabled vs disabled
- `jangar_event` emitted count by lane/tool kind
- render blob spillover count and bytes
- signed render URL validation failures
- detail iframe fetch failures
- OpenWebUI reducer drops due to duplicate `seq` or stale `revision`

## Rollout

### Phase 1

- Jangar rich render mode gate
- `delta.jangar_event`
- compact event schema
- render blob store
- signed detail endpoints
- unit tests

### Phase 2

- OpenWebUI fork reducer
- native activity rail cards
- persisted compact message metadata

### Phase 3

- Rich UI detail panes
- browser e2e for each `StreamDelta` kind
- reload/history validation

### Phase 4

- tune preview budgets
- remove duplicate OpenWebUI-only fallback noise if the rich renderer proves stable
- keep generic fallback for every other client

## Required Tests

### Jangar unit tests

- encoder emits `jangar_event` only in `rich-ui-v1`
- encoder still emits no `tool_calls`
- `seq` is monotonic
- stale `revision` events are not emitted
- command output sanitizer still strips reasoning details
- oversize payloads spill into render blobs and emit `renderRef`
- non-stream path remains content-only

### Codex client contract tests

- preserve current `StreamDelta` mappings for:
  - command
  - file
  - mcp
  - webSearch
  - dynamicTool
  - imageGeneration
  - plan
  - rate_limits
  - usage
  - error

### OpenWebUI fork tests

- reducer compacts events deterministically
- duplicate `seq` is ignored
- reload reconstructs the same activity rail
- expired render refs degrade gracefully
- message-level cards do not trigger native tool execution paths

### Browser e2e

- OpenWebUI chat stream renders cards for every current `StreamDelta` variant
- detail iframes load from the browser-reachable Jangar base URL
- iframe height autoresize works with same-origin disabled

## Exit Criteria

This design is implementation-ready when these statements are true:

- the SSE extension field and reducer semantics are fully specified
- persistence format is compact and bounded
- large payload spillover is explicit
- browser access and signature rules are explicit
- Rich UI is used where it helps, not as a blanket transport
- fallback behavior remains intact for every non-OpenWebUI client

That is the intended bar for this document.
