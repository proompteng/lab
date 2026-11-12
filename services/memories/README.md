# memories

This directory hosts the repository-context CLI and memory-note administration helpers. They use the Agents API.

Note: this service is intended for local/dev agents. Production deployments should use the Agents service directly (`services/agents`).

## Setup

```bash
bun install
```

### Agents endpoint

By default the helpers auto-detect runtime and use the REST endpoints:

- `POST /v1/memory-notes`
- `GET /v1/memory-notes`
- `GET /v1/memory-notes/<id>`

Default base URL selection:

- In Kubernetes namespace `agents`: `http://agents`
- In any other Kubernetes namespace: `http://agents.agents.svc.cluster.local`
- Outside Kubernetes: `http://agents.ide-newton.ts.net`

Override the base URL by setting `MEMORIES_AGENTS_URL` (or `AGENTS_SERVICE_BASE_URL` / `MEMORIES_BASE_URL`).
For debugging Kubernetes auto-detection, you can set `MEMORIES_K8S_NAMESPACE`.

## Scripts

### Retrieve repository context

```sh
bun run context:retrieve --query 'Agent Shell memory tools' --path services/agents/
```

Run this root script before substantial work. It retrieves bounded code excerpts and durable notes in one request.
The CLI verifies the indexed code against the checkout commit automatically and reports each source's availability.
Use `--expected-commit` for a different snapshot, `--tags` to scope notes, and `--json` for compact JSON output.
Run `bun run context:evaluate` after fetching `origin/main` to verify real implementation, incident and stale-snapshot cases.

### Save a memory

```bash
bun run save-memory --task-name "describe repo" --content "we changed X" \
  --summary "repo update" --tags task,repo
```

- `--content` or `--content-file` – the block of text to store.
- `--task-name` – namespace to store under (required).
- `--summary` – short overview (defaults to the first 300 characters of content).
- `--tags` – comma-separated list.
- `--repository` defaults to `proompteng/lab`; use it for another repository.
- `--commit` defaults to the current checkout's `HEAD` and must be a full Git SHA.
- `--json` returns the compact ID/timestamp receipt. Identical saves return the original note.
- Unsupported flags, including the removed `--metadata` and ignored legacy flags, fail before writing.

### Retrieve memories

```bash
bun run retrieve-memory --query "what did we build" --limit 5
```

- `--query` or `--query-file` – the prompt used to search the memory store.
- `--task-name` – optional namespace filter. If omitted, searches across all namespaces.
- `--limit` – up to how many matches to return (defaults to `5`).
- `--repository`, `--tags`, `--model`, `--after`, and `--before` filter candidates before retrieval.
- `--latest` lists compact summaries by creation time, without a query or embedding request.
- `--cursor` continues a latest listing using its `nextCursor`, with the same filters.
- `--id` reads a note by UUID, including retired history. Follow `nextOffset` with `--offset` to read all content.
- `--json` returns complete records for search, bounded chunks for `--id`, or summaries and a cursor for latest listing.
- `--include-retired` includes obsolete notes for historical inspection. Ordinary retrieval excludes them.
- Unsupported retrieval flags fail instead of being ignored.

See [engineering memory notes](../../docs/agents/memory-notes.md) for retirement, evaluation and the shared Agent Shell
and Agent Shell Tunnel tools.

## Testing

```bash
bun test tests
```

## Database schema

Agents handles embeddings and storage internally through the Agents-owned `memories.entries` table and migrations.
