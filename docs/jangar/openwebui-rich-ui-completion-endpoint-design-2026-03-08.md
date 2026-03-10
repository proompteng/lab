# OpenWebUI No-Fork Rich Activity Design For Jangar Chat Completions (2026-03-08)

## Decision

Upgrade Jangar's OpenAI-compatible `POST /openai/v1/chat/completions` path so vanilla OpenWebUI can present Codex activity as a production-quality, display-only experience without registering Codex tools in OpenWebUI and without forking the OpenWebUI frontend.

The production design is:

1. Keep Codex execution fully owned by Jangar.
2. Keep the primary chat UX on the standard OpenAI-compatible streaming contract that vanilla OpenWebUI already renders.
3. Make the existing text-first activity renderer the intentional primary UI for OpenWebUI, not a fallback of last resort.
4. Move oversized or highly structured detail into Jangar-hosted signed HTML detail pages reached through normal assistant-message links.
5. Treat `delta.jangar_event` and other backend rich-render plumbing as optional Jangar internals or future-facing transport, not as a required OpenWebUI product dependency.

This design explicitly rejects the earlier plan to patch OpenWebUI to interpret `choices[0].delta.jangar_event` and render native activity cards. That approach can be interesting for a client we control, but it is not the no-fork production plan for this repo.

## References

- OpenWebUI Rich UI docs:
  - `https://docs.openwebui.com/features/plugin/development/rich-ui/`
- OpenWebUI Events docs:
  - `https://docs.openwebui.com/features/plugin/development/events/`
- OpenWebUI OpenAI-compatible API integration docs:
  - `https://docs.openwebui.com/tutorials/integrations/openai-api/`
- OpenWebUI Direct Connections docs:
  - `https://docs.openwebui.com/tutorials/integrations/direct-connections/`
- OpenWebUI Reasoning & Thinking Models docs:
  - `https://docs.openwebui.com/features/plugin/functions/filter/reasoning/`
- OpenWebUI Open Responses docs:
  - `https://docs.openwebui.com/tutorials/integrations/openai-responses/`
- OpenWebUI deployment notes:
  - `docs/jangar/openwebui.md`
- Jangar chat request and stream orchestration:
  - `services/jangar/src/server/chat.ts`
- Jangar chat-completion encoder:
  - `services/jangar/src/server/chat-completion-encoder.ts`
- Jangar text-first tool renderer:
  - `services/jangar/src/server/chat-tool-event-renderer.ts`
- Jangar tool event decoder:
  - `services/jangar/src/server/chat-tool-event.ts`
- Jangar signed render URL helpers:
  - `services/jangar/src/server/openwebui-render-signing.ts`
- Jangar render blob store:
  - `services/jangar/src/server/openwebui-render-store.ts`
- Jangar render detail route:
  - `services/jangar/src/routes/api/openwebui/rich-ui/render/$renderId.ts`
- Jangar chat-completion tests:
  - `services/jangar/src/server/__tests__/chat-completions.test.ts`
- Jangar encoder tests:
  - `services/jangar/src/server/__tests__/chat-completion-encoder.test.ts`
- Canonical Codex stream normalization:
  - `packages/codex/src/app-server-client.ts`

## Upstream Reality Constraints

These are the constraints that matter for a no-fork design:

- Vanilla OpenWebUI knows how to render the standard OpenAI chat stream that Jangar already emits.
- OpenWebUI is designed around OpenAI-compatible chat/completions connections today; Open Responses support exists upstream but is explicitly experimental.
- OpenWebUI Rich UI embedding is designed around Tools and Actions that return inline HTML or iframe content within OpenWebUI's own plugin surface.
- OpenWebUI events allow custom event types, but the upstream docs are explicit that custom types require custom UI code to detect and handle them.
- OpenWebUI already has first-class reasoning UI for supported reasoning surfaces such as `reasoning_content` and tagged reasoning blocks; we should use that supported path rather than inventing custom reasoning markup.
- Jangar is not integrated as an OpenWebUI Tool or Action. Jangar is an external OpenAI-compatible chat-completions backend.
- This repo does not contain an OpenWebUI frontend patch or fork that consumes `delta.jangar_event`.
- Direct Connections are documented upstream as an experimental browser-to-provider mode. This design does not depend on Direct Connections and should assume the normal server-mediated connection path.

That leads to one hard product conclusion:

- If we will not fork OpenWebUI, the production UX must be built from the rendering surfaces that vanilla OpenWebUI already supports for an external model backend:
  - assistant text
  - supported reasoning surfaces
  - markdown
  - links
  - ordinary streaming semantics

## Current Implementation Facts

These are hard facts from `main`, not aspirations:

- OpenWebUI already talks to Jangar through the OpenAI-compatible streaming path and forwards `x-openwebui-chat-id`.
- Jangar treats OpenWebUI specially in `chat.ts`:
  - immediate SSE keepalive to prevent client-side aborts during Codex startup
  - Redis-backed persistence for thread id, transcript signature, turn number, and worktree name
  - stale-thread recovery by clearing stored state and replaying the transcript
- OpenWebUI state currently uses a 7-day TTL for the relevant Redis-backed stores.
- The current encoder already emits valid OpenAI streaming chunks for:
  - assistant text
  - reasoning
  - plan
  - rate limits
  - tools
  - usage
  - errors
- Jangar intentionally does not emit OpenAI `tool_calls` for Codex activity, and tests assert that behavior.
- Main now also contains backend-only rich-render plumbing:
  - `delta.jangar_event`
  - render blob staging and persistence
  - signed `renderRef` generation
  - a browser-facing detail route under `/api/openwebui/rich-ui/render/$renderId`
- The current render blob store TTL is `7 days`.
- The current signed render URL TTL constant is `15 minutes`.
- The current rich-render path is gated by both:
  - `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED`
  - request header `x-jangar-openwebui-render-mode: rich-ui-v1`
- The render detail route already serves escaped HTML with:
  - `Content-Disposition: inline`
  - `Cache-Control: no-store`
  - a restrictive CSP
  - iframe height reporting via `postMessage`

Those existing pieces are useful, but the no-fork design must not require any OpenWebUI-side reducer, card, or metadata schema.

## Problem

We need a production-quality OpenWebUI experience for Codex activity, but several unsafe or unsupported approaches are off the table:

- Do not register Codex tools in OpenWebUI.
- Do not emit OpenAI `tool_calls`.
- Do not let the browser become an execution authority.
- Do not require a custom OpenWebUI frontend patch.
- Do not dump arbitrarily large payloads into the chat bubble.

At the same time, the current plain markdown path is not yet specified with production rigor:

- tool summaries are not defined as a stable product contract
- large command output, diffs, and MCP payloads need explicit spillover behavior
- detail-link expiry and degradation behavior need definition
- reasoning, plan, and rate-limit rendering need consistent rules
- observability, rollout, and failure handling need to be explicit
- the current rich-render implementation couples blob staging and signed refs to `jangar_event` mode, but the no-fork production plan needs detail links to work independently of any custom OpenWebUI event transport

## Goals

- Keep Jangar as the only execution authority for Codex tools.
- Preserve the current OpenAI-compatible streaming path for every client.
- Give vanilla OpenWebUI a polished, readable activity experience without any frontend fork.
- Bound chat-bubble size and define exact spillover behavior for large detail.
- Reuse the signed render-page primitives already merged on `main`.
- Keep reload and history deterministic by relying on persisted assistant text plus Jangar-side detail blobs, not frontend metadata reducers.
- Lean on upstream-supported reasoning behavior instead of inventing a second reasoning UI scheme.
- Define enough contract detail that implementation and rollout can proceed without re-litigating architecture.

## Non-Goals

- Native OpenWebUI activity cards driven by `delta.jangar_event`.
- Any OpenWebUI reducer or message-metadata compaction layer.
- Registering Jangar or Codex as OpenWebUI Tools, Actions, or Pipes just to unlock embeds.
- Returning full raw Codex event history to the browser.
- Making OpenWebUI the owner of render-state persistence.
- Guaranteeing inline iframe embeds inside the chat transcript in v1.

## Product Shape

### Primary chat UX

The primary OpenWebUI experience is a purpose-built text renderer inside the assistant message. It should feel like an intentional activity transcript, not a debug dump.

For each activity kind, the assistant message should provide:

- a compact title
- a compact status line
- a small preview when preview adds value
- a plain-language explanation when the event matters to a user
- a normal markdown link to a Jangar-hosted detail page when the full payload is too large or too structured for chat

### Secondary detail UX

Oversized or structured detail lives outside the chat bubble in signed Jangar-owned HTML pages. These pages are read-only inspection surfaces, not execution surfaces.

Examples:

- full command transcript
- full unified diff
- MCP request/result/error inspector
- large reasoning snapshot
- image preview or result page
- long multi-section rate-limit or usage inspection when needed

### UX principle

Do not try to make vanilla OpenWebUI pretend to be a custom event renderer. The product should instead embrace a two-layer model:

- layer 1: readable assistant-message summaries
- layer 2: signed detail pages when inspection depth is needed

That is the no-fork equivalent of "rich rendering."

## Connection Mode Assumption

This design assumes the normal OpenWebUI OpenAI-compatible connection mode in which OpenWebUI talks to Jangar as a backend.

This design explicitly does not assume:

- Direct Connections
- OpenWebUI Tools/Actions as the primary Jangar integration surface
- Open Responses as the primary transport

Rationale:

- Direct Connections are experimental upstream and move the inference request path toward the browser.
- Jangar's current continuity model depends on server-owned thread and transcript state keyed through the OpenWebUI chat id header.
- The no-fork design needs a stable contract today, not a dependency on experimental connection modes or a re-architecture around OpenWebUI's plugin system.

## Architecture

### 1. Transport stays standard

The required production contract is the standard OpenAI-style streaming contract that vanilla OpenWebUI already consumes:

- `choices[0].delta.content`
- `choices[0].delta.reasoning_content`
- final usage payloads
- standard end-of-stream behavior

Jangar may continue to emit backend-only `delta.jangar_event` when explicitly enabled, but production correctness for OpenWebUI must not depend on it.

For reasoning specifically, the design should prefer upstream-supported reasoning surfaces over synthetic custom formatting whenever possible:

- `reasoning_content` when emitted
- existing tagged-reasoning compatibility behavior in OpenWebUI when applicable

### 2. Rendering responsibility stays in Jangar

Jangar is responsible for turning normalized Codex `StreamDelta` values into a polished assistant transcript. OpenWebUI simply renders the transcript it receives.

That means the product contract lives in:

- Jangar's text renderer
- Jangar's spillover rules
- Jangar's signed detail URLs

It does not live in:

- OpenWebUI message metadata
- OpenWebUI reducers
- OpenWebUI tool execution

### 3. Detail pages stay Jangar-owned

When Jangar decides that a payload should spill out of the chat bubble, it stages a render blob and appends a signed URL to assistant content.

The render blob and URL lifecycle remain a Jangar concern:

- blob creation
- TTL
- signature generation
- signature validation
- HTML escaping
- detail template rendering

### 4. Persistence stays simple

The persisted chat history remains the assistant text that OpenWebUI already stores plus Jangar's existing server-side thread and transcript state.

The no-fork design deliberately avoids inventing a second persisted state plane inside OpenWebUI.

### 5. Detail links are part of the product contract

If the assistant transcript contains a detail link, users will reasonably treat that link as part of the retained conversation.

That creates a hard product requirement:

- either the link remains usable for the retained lifetime of the conversation
- or the transcript points to a stable Jangar URL that can safely re-authorize or re-sign on demand

The current code shape does not fully satisfy that bar yet because blob retention and signed-link TTL are not aligned.

## Render Contract By Delta Kind

This section defines the production presentation contract for each normalized `StreamDelta` variant.

### `message`

- Primary surface:
  - normal `delta.content`
- Contract:
  - assistant prose remains authoritative
  - message text should not be duplicated into detail pages unless a single message body exceeds the preview budget
- Spillover:
  - only when an assistant text body itself becomes oversized
- Detail page:
  - plain escaped text view if needed

### `reasoning`

- Primary surface:
  - `delta.reasoning_content`
- Contract:
  - emit readable reasoning text only when the existing Jangar/OpenWebUI product chooses to expose it
  - avoid duplicating the same reasoning summary both as prose and as a second synthetic section
- Spillover:
  - if reasoning output becomes too large, preserve a short summary in-chat and add a detail link
- Detail page:
  - escaped text transcript of the reasoning snapshot

### `plan`

- Primary surface:
  - markdown checklist rendered into assistant content
- Contract:
  - preserve the current checklist semantics
  - at most one in-progress step
  - no hidden plan-only structure that the user cannot infer from the visible text
- Spillover:
  - not expected in normal use
  - if a plan becomes abnormally large, keep the first visible steps and link to detail
- Detail page:
  - markdown or escaped text plan snapshot

### `rate_limits`

- Primary surface:
  - concise markdown blockquote or compact subsection
- Contract:
  - show only user-meaningful fields
  - prefer human-readable time windows and reset timestamps
  - avoid repeated noisy emissions if nothing meaningfully changed
- Spillover:
  - rare
- Detail page:
  - structured JSON view only if the snapshot is unusually large

### `tool:command`

- Primary surface:
  - title
  - status
  - exit code when known
  - small stdout/stderr preview in fenced blocks when preview is meaningful
- Contract:
  - keep the preview readable and scoped
  - do not stream an unbounded terminal session directly into the message forever
  - sanitize preview text using the same safety rules already applied by the encoder
- Spillover:
  - full transcript moves to a detail page once preview budget is exceeded
- Detail page:
  - full escaped transcript including stdout, stderr, and any interactive input preview

### `tool:file`

- Primary surface:
  - changed path summary
  - compact diff preview when useful
- Contract:
  - keep previews focused on what changed, not entire files
  - for large changes, prefer path summary plus detail link over giant inline diffs
- Spillover:
  - full unified diff in detail page
- Detail page:
  - escaped unified diff viewer

### `tool:mcp`

- Primary surface:
  - tool name
  - status
  - compact argument summary
  - compact result or error summary
- Contract:
  - avoid dumping raw multi-kilobyte JSON into chat by default
  - preserve enough context that the user can tell what happened without opening detail
- Spillover:
  - full args/result/error payload to detail page when large
- Detail page:
  - escaped pretty-printed JSON inspector

### `tool:webSearch`

- Primary surface:
  - query
  - completion status
  - concise result summary when available
- Contract:
  - inline presentation should stay small
  - detail page is optional and should exist only if the result payload is materially useful

### `tool:dynamicTool`

- Primary surface:
  - tool name
  - high-level argument summary
  - success or failure outcome
- Contract:
  - v1 must treat this as first-class and not as an untyped blob
- Spillover:
  - full result or content items to detail page when large

### `tool:imageGeneration`

- Primary surface:
  - prompt summary
  - result status
  - direct asset link or Jangar-hosted preview link
- Contract:
  - avoid forcing image payload metadata into the transcript
  - keep in-chat text understandable even when the asset cannot load
- Spillover:
  - image detail page or asset URL

### `usage`

- Primary surface:
  - compact summary only when product chooses to expose it
- Contract:
  - usage should not dominate the visible transcript
  - usage is informational, not the primary activity UI
- Spillover:
  - optional structured detail page for debugging or operator use

### `error`

- Primary surface:
  - concise error explanation in assistant text
- Contract:
  - errors must remain visible and readable even if detail rendering fails
  - the user must not need a detail page to understand that the turn failed
- Spillover:
  - structured detail page with the escaped payload when that aids debugging

## End-To-End Examples

These examples make the contract concrete. They are intentionally approximate at the JSON field level but exact about the user-visible product shape.

### Example 1: command execution with spillover

Normalized deltas:

```json
[
  { "type": "tool", "toolKind": "command", "id": "cmd-1", "title": "Run tests", "status": "in_progress", "detail": "bun test packages/codex" },
  { "type": "tool", "toolKind": "command", "id": "cmd-1", "delta": "1200 lines of stdout/stderr..." },
  { "type": "tool", "toolKind": "command", "id": "cmd-1", "status": "completed", "exitCode": 1 }
]
```

Rendered assistant transcript:

````md
### Run tests
Status: completed with exit code 1

Command: `bun test packages/codex`

Preview:
```text
packages/codex/src/foo.test.ts:
  expected 2, received 1
...
```

[Open full transcript](https://jangar.example/api/openwebui/rich-ui/render/RENDER_ID?e=UNIX_SECONDS&sig=SIGNATURE)
````

Contract notes:

- the visible transcript already tells the user what ran and why it failed
- the detail link expands inspection depth only
- if detail staging fails, the transcript still includes the command, status, and a bounded preview

### Example 2: file edit with diff spillover

Normalized deltas:

```json
[
  { "type": "tool", "toolKind": "file", "id": "file-1", "title": "Update design doc", "detail": "docs/jangar/openwebui-rich-ui-completion-endpoint-design-2026-03-08.md" },
  { "type": "tool", "toolKind": "file", "id": "file-1", "status": "completed", "diffStat": "+42 -8" }
]
```

Rendered assistant transcript:

````md
### Update design doc
Status: completed
Path: `docs/jangar/openwebui-rich-ui-completion-endpoint-design-2026-03-08.md`
Change size: `+42 -8`

Summary:
- clarified supported vanilla OpenWebUI surfaces
- aligned detail-link retention with transcript expectations
- added concrete end-to-end examples

[Open full diff](https://jangar.example/api/openwebui/rich-ui/render/RENDER_ID?e=UNIX_SECONDS&sig=SIGNATURE)
````

Contract notes:

- the inline transcript summarizes the user-visible outcome rather than dumping a full diff
- the detail page owns the large unified diff view

### Example 3: MCP failure without requiring detail

Normalized deltas:

```json
[
  {
    "type": "tool",
    "toolKind": "mcp",
    "id": "mcp-1",
    "title": "memories.retrieve_memory",
    "status": "failed",
    "detail": "connection refused"
  }
]
```

Rendered assistant transcript:

```md
### memories.retrieve_memory
Status: failed
Summary: Could not reach the memories service. The turn continued without stored context.
```

Contract notes:

- the user does not need a detail link to understand the failure
- a detail link may exist for operators or debugging, but the summary stands on its own

## Assistant Message Formatting Contract

The text renderer should follow stable formatting rules so the chat output feels consistent across turns.

### General rules

- Prefer short labeled sections over raw JSON.
- Use markdown fences only for content that is naturally code or terminal output.
- Preserve chronological ordering within a turn.
- Avoid repeating the same status line on every incremental update.
- Avoid giant markdown tables that render poorly on mobile.
- Keep the most important user-facing conclusion near the bottom of the message, where it survives chat compaction best.

### Link rules

- Use explicit link labels:
  - `Open full transcript`
  - `Open full diff`
  - `Open full result`
  - `Open image preview`
  - `Open detail`
- Links should appear immediately after the preview they expand.
- Links must remain optional. The visible transcript should still stand on its own.

### Preview rules

- Command and diff previews should be truncated at natural boundaries when possible.
- Truncation should indicate that more content exists.
- If preview quality is poor, omit the preview and provide only the summary plus link.

## Payload Budget And Spillover

This is required for production quality.

Suggested initial limits:

- max inline preview per activity block:
  - `4 KiB` of rendered text
- max total activity-preview budget per assistant turn:
  - `24 KiB`
- max single structured payload kept inline before forced spillover:
  - `8 KiB`
- current backend rich-render preview limit in code:
  - `8,192 bytes`

These are product targets, not a promise that all current code already enforces them exactly. The important point is that the design explicitly requires bounded in-chat output.

Spillover rules:

- keep a compact preview in the assistant message
- stage the full payload in the render blob store
- append a signed link to the detail page
- never make the in-chat summary depend on the detail page remaining available

The main experience must survive detail-link expiry. Expiration should degrade inspection depth, not turn the transcript into gibberish.

## Render Blob And Detail Page Contract

The existing render blob path on `main` is the right primitive for no-fork drill-down.

### Blob contents

Each render blob should include:

- stable `renderId`
- semantic `kind`
- logical source identifier
- lane
- escaped or escapable payload
- preview metadata when useful
- message binding hash
- creation timestamp
- expiry timestamp

### Store requirements

- default store:
  - Redis
- test/development fallback:
  - in-memory store
- default TTL:
  - `7 days`
- key prefix:
  - `openwebui:render`

### URL requirements

- browser-reachable absolute base URL via `JANGAR_OPENWEBUI_EXTERNAL_BASE_URL`
- signed link
- `renderId` path parameter
- signature and expiry in query params
- message binding incorporated into the signature payload

Production decision:

- v1 should not ship with transcript-visible links that expire materially earlier than the retained conversation unless a re-sign flow exists
- because the current code keeps blobs for `7 days` but signs links for `15 minutes`, production rollout must do one of:
  - align signed-link TTL with retained blob lifetime
  - add a stable Jangar route that can re-authorize or re-sign detail access without changing the stored transcript

Preferred v1 choice:

- make signed detail-link TTL match the render blob TTL and retained conversation horizon

Rejected v1 choice:

- leaving transcript-visible links to die after `15 minutes` while the conversation remains visible for `7 days`

### Response requirements

The detail endpoint should return:

- `Content-Type: text/html; charset=utf-8`
- `Content-Disposition: inline`
- `Cache-Control: no-store`
- `Access-Control-Expose-Headers: Content-Disposition`

The current route already does this and should remain the base implementation.

### HTML requirements

- render escaped text or JSON only
- no raw tool output injected as trusted HTML
- Jangar-owned templates only
- restrictive CSP by default
- auto-resize height reporting with `postMessage`

### Browser reachability

OpenWebUI talks to Jangar's chat-completions endpoint server-to-server, but detail pages are fetched by the user's browser. That means:

- cluster-internal service URLs are not sufficient for detail pages
- `JANGAR_OPENWEBUI_EXTERNAL_BASE_URL` is required for signed links
- the chosen base URL must be reachable from the user's browser environment

### Route shape

The current route shape is the correct production baseline:

- path:
  - `/api/openwebui/rich-ui/render/$renderId`
- query params:
  - `e=<unix-seconds>`
  - `sig=<signature>`

Expected error semantics:

- `400` for malformed requests
- `404` for invalid signatures or missing blobs
- `410` for expired links
- `503` for missing render infrastructure such as signing or store availability

## Security Model

### Execution safety

- Jangar remains the only execution authority.
- OpenWebUI never receives executable Codex tool definitions.
- Detail pages are read-only and must not perform server-side actions.
- The browser never invokes Codex tools directly.

### Link integrity

- links must be signed
- links must expire
- invalid or expired signatures return a safe error page, not raw payload data
- signatures should bind at least:
  - `renderId`
  - `kind`
  - `expiresAt`
  - message-scoped binding hash

### Content safety

- tool output is treated as untrusted content
- detail pages escape payloads before rendering
- images or remote assets should be linked deliberately, not blindly embedded from arbitrary sources

### Privacy and retention

- render blob TTL should align with existing OpenWebUI conversation state retention unless there is a specific reason to shorten it
- logs should never store full sensitive payloads just because detail pages exist
- if longer-lived signed URLs are used in v1, secret rotation and routine expiry remain the primary containment mechanism; do not log full URLs

## Failure Modes

The product must degrade cleanly.

### Render blob store unavailable

- Jangar still emits the text-first summary
- Jangar omits the detail link when the full payload cannot be staged safely
- the turn remains readable

### External base URL missing

- Jangar still emits the text-first summary
- signed detail links are disabled
- logs record configuration failure once per process start or at a rate-limited cadence

### Signature validation failure

- detail route returns a safe error page
- the chat transcript remains intact
- a counter is incremented for operator visibility

### Detail blob expired or missing

- detail route returns a safe "detail unavailable" page
- the summary text remains authoritative
- expired links are acceptable only after the retained conversation horizon or after an intentionally documented shorter policy

### Oversized payload

- Jangar truncates the in-chat preview
- Jangar stages full detail when possible
- if staging fails, Jangar keeps the truncated summary rather than streaming unlimited data

### Browser cannot reach external base URL

- the visible transcript still works
- the detail link fails independently
- this should surface in monitoring and manual validation

## Existing Rich-Render Plumbing On Main

Main already contains more than this no-fork plan strictly requires:

- `delta.jangar_event`
- render blob staging in the encoder
- signed `renderRef` generation
- detail-route infrastructure

This design treats those pieces as follows:

- signed render blobs and detail routes:
  - keep and use
- `delta.jangar_event`:
  - explicitly non-essential for OpenWebUI production correctness
  - keep behind feature gating if useful for alternate clients, experiments, or future upstream extension points
  - default off in production until there is a concrete consumer beyond experiments
- any notion of OpenWebUI-side reducer or metadata compaction:
  - out of scope for the no-fork production plan

That preserves useful backend work without anchoring product correctness to a frontend fork.

## Jangar Server Changes

### `chat-tool-event-renderer.ts`

This renderer becomes the primary OpenWebUI presentation layer and should be upgraded accordingly.

Required improvements:

- normalize the visual structure across tool kinds
- make previews intentionally concise
- emit canonical link labels
- ensure truncation is readable
- keep command, file, and MCP output distinct and recognizable
- preserve the existing guarantee that no OpenAI `tool_calls` are emitted

### `chat-completion-encoder.ts`

Keep:

- the current OpenAI-compatible stream behavior
- reasoning and plan formatting helpers
- the existing render blob spillover primitives

Change:

- treat spillover and detail-link emission as a production feature independent of `jangar_event`
- ensure the text transcript can reference detail links cleanly
- keep `jangar_event` gated and explicitly non-essential for OpenWebUI correctness
- add transcript snapshot coverage for user-visible formatting, not only structured-event coverage

### `chat.ts`

Keep:

- heartbeat behavior
- stale-thread retry
- transcript reconciliation
- OpenWebUI chat-id handling

Change:

- make rich detail runtime configuration explicit
- fail open to text-only mode when signed detail prerequisites are missing
- do not let signed-link failures break the main assistant stream

### Detail route and templates

Keep the existing route and evolve templates by payload kind:

- command transcript template
- diff template
- JSON inspector template
- image preview template
- generic text fallback

## Observability

Add or preserve counters and logs for:

- OpenWebUI rich-detail mode enabled vs disabled
- detail-link creation success vs skipped vs failed
- render blob persistence failures
- render blob bytes staged
- detail route hits by kind
- detail route signature failures
- detail route expired-link responses
- detail route missing-blob responses
- assistant previews truncated by kind
- fallback to text-only mode because external base URL or signing secret was unavailable

Initial alert thresholds:

- page when render-store persistence failures exceed `1%` of OpenWebUI rich-detail eligible turns over `15m`
- page when valid detail-route requests return `5xx` above `1%` over `15m`
- investigate when signature failures exceed `0.1%` of detail-route hits over `15m`
- investigate when missing-blob responses occur after successful link creation in the same deployment epoch

Logs should identify:

- chat id when available
- thread id when available
- render kind
- render id when safe to log

Logs must not dump full sensitive payload content by default.

## Rollout

### Phase 1

- standardize the text renderer contract
- define preview limits
- align signed detail-link TTL with retained blob lifetime, or implement an approved re-sign flow
- validate signed detail routes and blob TTL behavior
- keep the user-facing UX entirely text-plus-links

### Phase 2

- improve per-kind detail templates
- tune truncation and preview quality
- validate browser reachability from the real OpenWebUI environment

### Phase 3

- add observability and operator runbooks
- validate failure-mode behavior under missing blob, expired link, and broken external URL cases

### Phase 4

- decide whether `delta.jangar_event` remains as an experimental transport for non-OpenWebUI clients or future upstream opportunities
- do not let that decision block the production no-fork rollout

## Required Tests

### Jangar unit tests

- encoder still emits no OpenAI `tool_calls`
- text rendering remains valid for every current `StreamDelta` kind
- oversized payloads stage render blobs when configured
- signed links include expiry and signature
- blob persistence waits are correct before exposing signed detail refs where ordering matters
- missing render runtime configuration falls back cleanly to text-only mode

### Detail route tests

- valid signed link returns inline HTML
- invalid signature returns safe error page
- expired link returns safe error page
- missing blob returns safe error page
- HTML output escapes payload content
- iframe height reporting script remains present

### OpenWebUI integration tests

- vanilla OpenWebUI renders the assistant transcript correctly with no custom frontend code
- markdown links point to the browser-reachable Jangar base URL
- detail links are optional and do not break the main transcript when unavailable
- reasoning content uses upstream-supported reasoning rendering rather than a custom transcript convention

### Browser e2e

- command summary plus detail link works end-to-end
- diff summary plus detail link works end-to-end
- MCP summary plus detail link works end-to-end
- image link or preview link works end-to-end
- mobile and desktop renderings remain readable
- a transcript retained longer than `15 minutes` still contains usable detail links, or the product exposes an approved re-sign path

## Runbook Notes

Operators need a short checklist when detail links do not work:

1. Verify `JANGAR_OPENWEBUI_EXTERNAL_BASE_URL` is configured and browser-reachable.
2. Verify `JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET` is configured.
3. Verify the render blob store is reachable and populated.
4. Verify the signed-link TTL policy matches the deployed product contract.
5. Confirm the chat transcript itself remains readable even if detail pages fail.
6. Check signature-failure and missing-blob counters before assuming a frontend problem.

## Exit Criteria

This design is implementation-ready when these statements are true:

- the primary OpenWebUI UX is fully specified without any frontend fork
- the assistant text format is treated as a stable product contract
- spillover behavior is bounded and explicit
- signed detail pages are clearly specified
- failure modes preserve a usable transcript
- security rules keep Jangar as the sole execution authority
- tests and rollout phases cover the real operational risks

That is the bar for a production-quality no-fork design in this repo.
