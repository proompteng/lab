# Engineering memory notes

Agents owns one PostgreSQL note store and its `/v1/memory-notes` API. The Bun CLI, Agent Shell and Agent Shell
Tunnel use that API. The tunnel forwards to the same MCP server as Agent Shell.

## Database and delivery

Production notes live in `agents.memories.entries` on the Galactic cluster: namespace `agents`, CNPG cluster
`agents-db-next`, read/write service `agents-db-next-rw.agents`. The [cluster manifest](../../argocd/applications/agents/postgres-cluster.yaml)
owns its 50 GiB `rook-ceph-block` volume. Agents reads the connection from the existing `agents-db-app` Secret.

Schema changes are registered in [the Kysely migration provider](../../services/agents/src/server/kysely-migrations.ts).
With `AGENTS_MIGRATIONS=auto`, initializing a database store runs pending migrations under Kysely's migration lock;
`agents_kysely_migration` records applied versions. Migration errors fail the operation. The retirement migration adds
columns and active-note indexes in place. The save-key migration gives identical notes one replay key, including historical notes.
Existing duplicate rows, content and embeddings are preserved. The earliest duplicate owns the replay key.

After a reviewed merge, the [Agents image workflow](../../.github/workflows/agents-build-push.yml) publishes the immutable
image cohort. Kargo promotes it through `kargo/agents`, then Argo reconciles the rollout. See the
[release contract](../release-automation.md). No manual SQL or separate memory deployment is required for this change.

## Retrieve repository context

Use one query to retrieve current code and durable engineering notes:

```sh
bun run context:retrieve --query 'Agent Shell memory tools' --path services/agents/
```

The CLI supplies the checkout's Git commit automatically. `--expected-commit` overrides it. Code is returned only when
Atlas is ready and its indexed commit agrees with the requested checkout. A stale snapshot is reported explicitly;
use local Git and `rg` for branch changes. Without an expected commit, `snapshotVerified` is false.

Each code hit includes a distinct file path, line bounds, commit and content hash. Each note includes its ID,
creation time and source commit. Excerpts are bounded UTF-8 previews with explicit truncation and omission counts.
`--json` emits compact machine-readable output. `--path` filters code; `--tags` filters notes. Both sources share
the repository scope, which defaults to `proompteng/lab`.

`code.state` and `memory.state` distinguish usable results from stale, degraded or unavailable sources. An available
source with no matches has `state=ready` and an empty result list. One source failure preserves the other source's
evidence. Neither source establishes current runtime behavior; use the existing operational tools for live readback.
Each source has a 15-second deadline, below the shared client's 35-second deadline. A stalled memory embedding is
cancelled and reported as unavailable while usable code is retained.

The same API powers the CLI and the `retrieve_context` tool on both Agent Shell connectors. It replaces `memory_search`.
The MCP reply budget includes structured and text content plus transport metadata.

## Search or list notes

Before substantial work, search for the task and its identifiers. Scope the repository and tags when known.
Search combines semantic and lexical candidates, ranks their relevance, and can return fewer results than requested.
An unrelated request should return no notes.

```sh
bun run --cwd services/memories retrieve-memory \
  --query 'native arrival copy psql partial stdout verification' \
  --repository proompteng/lab --tags bayn --limit 5
```

For recent changes, list by creation time instead of using a semantic query:

```sh
bun run --cwd services/memories retrieve-memory --latest \
  --repository proompteng/lab --model qwen38-flamingo --after 2026-11-01 --limit 5 --json
```

`--after` is inclusive and `--before` is exclusive. Both accept ISO dates or timestamps with a time zone.
Multiple comma-separated `--tags` must all match. Notes without the requested repository or model metadata are excluded.
Latest listing returns compact summaries and `nextCursor`. Repeat the same filters with `--cursor '<nextCursor>'` to continue.
The cursor uses the last visible note ID and the database timestamp at full precision. Newer inserts do not repeat earlier pages;
retiring the cursor note does not invalidate it. No embedding is requested for listing or reading.

Open an exact note, including retired history:

```sh
bun run --cwd services/memories retrieve-memory --id '<note UUID>' --json
```

`--id` returns bounded content chunks and provenance. Repeat with `--offset <nextOffset>` until `nextOffset` is null
to read all content. Query search returns full records with `--json`; its text output caps content at 4,000 characters
and points to the exact-ID read command. Unsupported flags fail instead of being silently ignored.

Agent Shell and Agent Shell Tunnel expose the same tools without a repo session:

| Tool               | Purpose                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `retrieve_context` | Retrieve bounded code and engineering notes with explicit snapshot freshness and source availability.              |
| `memory_list`      | Browse compact summaries with the same filters. Continue with `nextCursor`.                                        |
| `memory_get`       | Read an exact note ID, including retirement status. Follow `nextOffset` until null for the complete content.       |
| `memory_save`      | Save explicitly requested knowledge with `repository` and full `commit` fields. Identical saves reuse the note ID. |
| `memory_retire`    | Retire a verified obsolete or incorrect note, with a reason and optional active replacement.                       |

Memory tool audit events retain call identity and outcome without copying queries, note bodies or results into shell logs.
Save and retire return compact receipts with note IDs and timestamps. `memory_get` returns bounded UTF-8 content chunks;
`offset` counts Unicode characters and comes from the previous `nextOffset`. The complete reply fits the configured budget.
A retired note remains readable with its reason and replacement ID. Any reason shortened to fit is marked explicitly.
Listing never copies full note bodies into the response. If its reply budget reduces the page, the cursor resumes after the last visible note.

## Save requested knowledge

`memory_save` takes `repository` and `commit` directly, with optional namespace, summary and tags. Repository defaults to
`proompteng/lab`. It rejects the removed freeform `metadata` argument. The API retains application metadata for generators
such as Bumba; all writes share the same store and replay-key calculation.

```sh
bun run --cwd services/memories save-memory --task-name 'engineering' \
  --repository proompteng/lab --content-file './requested-note.md' --summary 'Verified constraint' --json
```

The CLI defaults the commit to its checkout's `HEAD`; `--commit` supplies another full source SHA. Use `--repository`
for another repository. Both values are validated before writing. Saves return HTTP 200 with the persisted record.
The MCP and CLI return compact receipts.

Identical namespace, content, summary, tags and metadata reuse the original ID and creation time. Tag order and metadata
key order do not create duplicates. A unique database key handles simultaneous retries and uncertain responses.
A replay of a retired note stays retired. Save corrected content or provenance to create a new note.

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
bun run context:evaluate --expected-commit "$(git rev-parse origin/main)"
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
