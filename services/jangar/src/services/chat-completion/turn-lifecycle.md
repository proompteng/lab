# Turn lifecycle guard (December 2, 2025)

Goal: enforce **one active Codex turn per OpenWebUI chat** and avoid noisy ghost events when the HTTP stream ends before Codex stops.

## Guard
- `activeTurnByChatId` records the single in-flight turn for each `chatId` (namespaced per user).
- `/openai/v1/chat/completions` rejects a request with `409` if that chat already has an active turn.
- The guard is cleared exactly once when the stream settles (success, error, timeout, or client abort), not when the handler returns.

## Abort/timeout behaviour
- When the HTTP request aborts or the stream times out, Jangar asks Codex to interrupt the turn (`turn/interrupt`) before cleaning up local state.
- `threadMap` is **not** deleted on abort/timeout unless the turn interrupt succeeds and the thread is unusable; this prevents losing the Codex `thread_id` while Codex is still emitting events.

## Codex client notifications
- Notifications with an explicit `turn_id` are routed to that stream; if the stream is already gone we log at info level and drop the event (expected late arrival).
- Notifications without `turn_id` only fall back to the last active stream when there is exactly one active stream; otherwise they are ignored with an info log to avoid mis-routing.

Invariant: _one conversation/chat → at most one active Codex turn/stream at any moment_.
