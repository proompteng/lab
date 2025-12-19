---
name: memories
description: Use the memories MCP tools with the default namespace.
---

## Scope
- Memories MCP tools: `persist_memory` and `retrieve_memory`.
- Always store and query memories in the `default` namespace.

## Persisting Memories
- Required fields: `{ namespace: 'default', content }`.
- Optional fields: `summary`, `tags`.
- Never write to any namespace other than `default`.

## Retrieving Memories
- Use `{ namespace: 'default', query, limit? }`.
- Prefer small `limit` values (e.g. 5–10) unless the task demands more.
