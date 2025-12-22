---
name: memories
description: Use the memories CLI helpers (Jangar REST) with concise task namespaces.
---

## Scope
- Use the CLI helpers from repo root: `bun run --filter memories save-memory` and `bun run --filter memories retrieve-memory`.
- Prefer concise, stable task names (they become the namespace).

## Persisting Memories
- Required flags: `--task-name "<short>"` and `--content "<text>"` (or `--content-file`).
- Optional flags: `--summary "<1 line>"`, `--tags "<comma,separated>"`.
- Keep `--task-name` short and consistent for related changes.

## Retrieving Memories
- Required: `--query "<search text>"` (or `--query-file`).
- Optional: `--task-name "<short>"` to scope to a namespace, `--limit <n>`.
- Prefer small `limit` values (e.g. 5–10) unless the task demands more.
