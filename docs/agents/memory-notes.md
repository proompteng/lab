# Engineering memory notes

Agents owns one PostgreSQL note store and its `/v1/memory-notes` API. The Bun CLI, Agent Shell and Agent Shell
Tunnel use that API. The tunnel forwards to the same MCP server as Agent Shell.

## Retrieve context

Before substantial work, search for the task and its identifiers. Scope the repository and tags when known.
Search combines semantic and lexical candidates, ranks their relevance, and can return fewer results than requested.
An unrelated request should return no notes.

```sh
bun run --filter memories retrieve-memory \
  --query 'native arrival copy psql partial stdout verification' \
  --repository proompteng/lab --tags bayn --limit 5
```

For recent changes, list by creation time instead of using a semantic query:

```sh
bun run --filter memories retrieve-memory --latest \
  --repository proompteng/lab --model qwen38-flamingo --after 2026-11-01 --limit 5 --json
```

`--after` is inclusive and `--before` is exclusive. Both accept ISO dates or timestamps with a time zone.
Multiple comma-separated `--tags` must all match. Notes without the requested repository or model metadata are excluded.
`--json` returns full content and provenance; text output caps each note's content at 4,000 characters and marks truncation.
Unsupported flags fail instead of being silently ignored.

Agent Shell and Agent Shell Tunnel expose the same tools without a repo session:

| Tool            | Purpose                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `memory_search` | Search by query, repository, tags, model and creation-date range.                                              |
| `memory_list`   | List newest notes with the same filters, without requesting an embedding.                                      |
| `memory_save`   | Save durable knowledge when the user explicitly requests it. Put repository and commit provenance in metadata. |
| `memory_retire` | Retire a verified obsolete or incorrect note, with a reason and optional active replacement.                   |

Memory tool audit events retain call identity and outcome without copying queries, note bodies or results into shell logs.
Save and retire return compact receipts with note IDs and timestamps. Read full notes through search or listing.

## Retire obsolete notes

Notes describe evidence from their recorded source commit. Verify material claims against current source or live behavior.
Age alone does not invalidate an architectural constraint or failure pattern. There is no automatic expiry or claim that
historical notes have all been reviewed.

After verifying that a note is incorrect or superseded, retire it explicitly:

```sh
bun run --filter memories retire-memory --id '<note UUID>' \
  --reason 'The recorded constraint was removed by the verified source change.' \
  --replacement-id '<active replacement note UUID>'
```

The replacement is optional. It must be active, different from the retired note, and belong to the same repository.
Retirement preserves content and provenance. Search and listing exclude retired notes by default; use `--include-retired`
to inspect history. An identical retry returns the original retirement. A conflicting retry fails instead of overwriting it.

## Generation and evaluation

Bumba generates merge notes after successful main-branch ingestion. It supplies a bounded before/after Git diff,
commit-message context and available file enrichments to the configured Flamingo model. The model returns `save` or `skip`.
Commit-derived notes do not establish current deployment or runtime behavior.

Run the real CLI evaluation against the configured Agents endpoint:

```sh
bun run --filter memories evaluate-memory
```

The fixed cases cover MCTS evidence binding, partial database reads, Valkey promotion, paraphrases and an unrelated request.
They check retrieval against immutable source commits. They do not measure whether memory improves completed engineering tasks.
The PostgreSQL integration test covers filtering, ordering, retirement races, the HTTP API, the Bun CLI and both shell resources:

```sh
AGENTS_STORE_TEST_DATABASE_URL=postgresql://localhost/test \
  bun run --filter @proompteng/agents test src/server/memory-notes.integration.test.ts
```

The test creates and drops its own database through that test connection. It requires PostgreSQL with pgvector and
permission to create databases. It never writes evaluation notes into the production memory store.
