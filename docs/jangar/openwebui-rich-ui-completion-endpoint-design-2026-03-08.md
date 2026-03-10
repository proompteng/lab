# OpenWebUI No-Fork Rendering Plan For Jangar Chat Completions (2026-03-08)

## Decision

Do not fork or patch OpenWebUI for Jangar chat rendering.

The production shape is:

1. Keep Codex execution fully owned by Jangar.
2. Keep Jangar on the existing OpenAI-compatible `POST /openai/v1/chat/completions` path.
3. Treat vanilla OpenWebUI as a standard chat client, not as a custom activity-renderer host.
4. Keep the primary in-chat experience text-first using the normal OpenAI chunk fields that OpenWebUI already renders.
5. Use Jangar-hosted signed HTML pages only for optional drill-down views that open from normal links.

This document intentionally rejects the earlier plan to patch OpenWebUI to understand `choices[0].delta.jangar_event`. That is not required for a production-quality no-fork rollout, and it is not a supported extension point in stock OpenWebUI.

## Why The Old Plan Was Wrong

The previous design mixed together two different things:

- Rich UI embeds that stock OpenWebUI supports for its own Tools and Actions.
- Native rendering of arbitrary custom event types coming from an external OpenAI-compatible model stream.

Vanilla OpenWebUI supports the first, not the second.

OpenWebUI's official docs currently describe Rich UI embedding for Tools and Actions returning HTML/iframes, and they describe custom event types as something you can use only if they are handled in your own UI code. That means the earlier "`jangar_event` + patch OpenWebUI" design was effectively a frontend-fork plan disguised as a transport plan.

Relevant upstream docs:

- Rich UI embedding:
  - `https://docs.openwebui.com/features/plugin/development/rich-ui/`
- Events:
  - `https://docs.openwebui.com/features/plugin/development/events/`

## Reality Constraints

These are the constraints that matter for this repo today:

- OpenWebUI is talking to Jangar over the OpenAI-compatible chat-completions API.
- Jangar already maintains OpenWebUI chat/thread/transcript/worktree state in Redis.
- The current fallback renderer already converts Codex activity into OpenWebUI-friendly text and fenced blocks.
- Main now also contains backend-only rich-render plumbing:
  - `choices[0].delta.jangar_event` emission
  - signed `renderRef` generation
  - render blob storage
  - browser-facing signed render endpoints
- This repo still does not contain an OpenWebUI frontend patch or fork that consumes `jangar_event`.

Those facts force a simple conclusion:

- If we refuse a fork, we must design around stock OpenWebUI behavior.
- Therefore the primary UX must be built from normal assistant text that vanilla OpenWebUI already knows how to render.

## Product Goal

Give users a reliable, readable view of Codex activity in vanilla OpenWebUI without:

- registering Codex tools in OpenWebUI
- emitting executable OpenAI `tool_calls`
- requiring a frontend fork
- making the browser an execution authority

## Non-Goals

- Native OpenWebUI activity cards driven by custom SSE delta fields.
- Teaching OpenWebUI to understand `jangar_event`.
- Reframing Jangar as an OpenWebUI Tool, Action, or Pipe just to get iframe rendering.
- Full-fidelity replay of every internal Codex delta inside chat history.
- Rich inline embeds for every tool event.

## No-Fork Architecture

### 1. Primary in-chat rendering stays text-first

Jangar continues to emit ordinary OpenAI-style streaming chunks that stock OpenWebUI already renders:

- `choices[0].delta.content`
- `choices[0].delta.reasoning_content`
- final usage/error payloads as already implemented

Codex tool activity remains summarized as markdown and fenced text through the existing fallback renderer.

This is not a compromise workaround. It is the only fully supported rendering surface available to an external OpenAI-compatible backend without modifying the OpenWebUI frontend.

### 2. Rich detail moves out of the chat bubble

When a tool result is too large or too structured for the chat bubble, Jangar serves a signed HTML detail page from its own backend and exposes it as a normal link inside assistant content.

Examples:

- full command transcript
- full unified diff
- full MCP request/result/error inspector
- image preview/detail page
- large reasoning or plan snapshots when needed

The key point is that vanilla OpenWebUI only needs to render a normal link. It does not need to understand a new event type or host a custom card renderer.

### 3. `renderRef` remains a Jangar concern

The backend pieces already merged on `main` are still useful, but their role changes:

- `renderRef` is an internal Jangar mechanism for creating signed detail URLs.
- render blobs remain a Jangar persistence concern.
- signed render endpoints remain useful.
- `jangar_event` is no longer a required product contract for OpenWebUI.

If `jangar_event` remains in the codebase, it should be treated as experimental or future-facing, not as something the production UX depends on.

### 4. OpenWebUI stays vanilla

No reducer patch.
No custom cards.
No message-metadata compaction logic in the frontend.
No OpenWebUI fork lifecycle to maintain.

## Concrete UX Shape

### Command execution

Render a compact, readable summary in the assistant message:

- command title
- started/running/completed state
- exit code when present
- truncated stdout/stderr preview in fenced blocks
- a normal markdown link to "Open full transcript" when detailed output exists

### File changes

Render:

- changed path summary
- small diff preview when useful
- a normal markdown link to "Open full diff" for larger changes

### MCP tool calls

Render:

- tool name
- compact status
- compact args/result/error summary
- a normal markdown link to "Open full result" for large payloads

### Dynamic tools and image generation

Render:

- tool name / prompt summary
- compact success/failure outcome
- normal links to Jangar-hosted detail pages or asset URLs

### Plans, reasoning, and rate limits

Keep these in normal text form unless there is a clear product reason to expose a separate detail page.

## Transport Contract

### Required contract

The required, production contract is the one vanilla OpenWebUI already supports:

- standard streaming OpenAI chat-completion chunks
- normal markdown/text content inside assistant messages

That is the contract we should optimize.

### Optional contract

`choices[0].delta.jangar_event` may continue to exist behind a feature flag for:

- internal experimentation
- future upstream extension points
- alternate clients we control

But OpenWebUI production behavior must not depend on it.

## Jangar Server Changes

### Keep

- existing OpenWebUI-specific heartbeat behavior
- stale-thread retry and transcript reconciliation
- text-first fallback renderer in `chat-tool-event-renderer.ts`
- signed render endpoint support
- render blob storage for large detail payloads

### Change

Shift the responsibility for "richness" from custom frontend rendering to better assistant-text formatting plus explicit signed links.

Concretely:

- the fallback renderer should become the primary renderer for OpenWebUI
- when a detail page exists, append a normal markdown link in assistant content
- previews should stay small and readable in-chat
- large structured payloads should live behind Jangar detail pages, not inside OpenWebUI message metadata

### Do not require

- OpenWebUI reducer changes
- frontend message metadata schema
- compaction/replay logic in OpenWebUI
- any patch that consumes `jangar_event`

## Render Endpoint Requirements

The existing Jangar render endpoint shape is still correct for no-fork detail pages.

Requirements:

- browser-reachable URL base
- signed URLs
- `Content-Type: text/html; charset=utf-8`
- `Content-Disposition: inline`
- `Cache-Control: no-store`
- `Access-Control-Expose-Headers: Content-Disposition`

Add or keep:

- `JANGAR_OPENWEBUI_EXTERNAL_BASE_URL`
- render URL signing secret
- short-lived signed URLs
- render blob TTL aligned with existing OpenWebUI state TTL

## Security Model

- Jangar remains the only execution authority.
- OpenWebUI never receives executable Codex tool definitions.
- The browser only fetches read-only signed detail pages.
- Tool output is never injected as trusted HTML.
- Jangar-owned templates render escaped text and structured data safely.

## Current Repo Status

As of `main` on 2026-03-10:

- The text-first fallback path is implemented and production-usable.
- Backend rich-render plumbing is also implemented in Jangar.
- The OpenWebUI frontend-side renderer is not present in this repo.

That means the only production-ready no-fork path is the text-first path plus signed Jangar detail links.

## Recommendation

Adopt this as the product plan:

1. Keep vanilla OpenWebUI.
2. Make the fallback text renderer the intentional primary experience.
3. Improve the summaries so they read like purpose-built activity output, not debug dumps.
4. Reuse the signed render pages for drill-down links where richer inspection matters.
5. Stop describing an OpenWebUI frontend patch as part of the required architecture.

## Implementation Notes For This Repo

The relevant code remains:

- chat request/stream orchestration:
  - `services/jangar/src/server/chat.ts`
- text-first tool rendering:
  - `services/jangar/src/server/chat-tool-event-renderer.ts`
- optional structured event emission:
  - `services/jangar/src/server/chat-completion-encoder.ts`
- signed render URLs:
  - `services/jangar/src/server/openwebui-render-signing.ts`
- render blob storage:
  - `services/jangar/src/server/openwebui-render-store.ts`
- render detail route:
  - `services/jangar/src/routes/api/openwebui/rich-ui/render/$renderId.ts`

The main follow-up work should happen in the text renderer and message formatting, not in an OpenWebUI fork.

## Open Questions

- Do we want detail links to open in a new tab, or should we rely on normal in-app navigation behavior only?
- Should command/file/MCP detail links be shown only on completion, or also while the tool is running?
- How much preview text is useful before the assistant message becomes noisy?
- Should image-generation results link directly to the asset, a Jangar viewer page, or both?

## Final Position

If we want no fork, we must stop pretending stock OpenWebUI can natively render our custom stream protocol.

The realistic design is:

- vanilla OpenWebUI for chat rendering
- Jangar for execution and detail rendering
- normal assistant text for primary UX
- signed Jangar links for deep inspection

That is boring, but it is real.
