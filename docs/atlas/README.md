# Atlas Code Search

Status: Current operating entrypoint. Initial production acceptance passed on 2026-07-17. Atlas is trusted only while
the live indexed commit matches the exact requested Git ref, search reports no degradation, and current behavior does not
contradict the acceptance contract below. A mismatch, timeout, stale result, or irrelevant lexical fallback reopens the
gate until reconciliation and `atlas:verify` pass again.

Atlas is the repository ingestion, indexing, and search system used by Jangar, Bumba, Codex, and other agents. Its job
is not merely to return plausible code. It must identify the exact indexed repository snapshot, search the complete
eligible corpus, exclude deleted content, expose degradation honestly, and let an operator reproduce every result from
Git and database evidence.

The implementation repairs the existing Atlas schema and tables in place. The invalid corpus is truncated once and
rebuilt from Git during maintenance; retries continue in the same tables and never create a second corpus.

## Start Here

- Production design and rollout plan: `production-code-search-design.md`
- Jangar search and MCP surface: `../../services/jangar/README.md`
- Bumba ingestion worker: `../../services/bumba/README.md`
- Repository documentation authority: `../documentation-authority.md`
- Temporal operating contract: `../../skills/temporal/SKILL.md`

## Current Authority

When sources disagree, use this order:

1. The exact Git commit and current service/GitOps source.
2. Live PostgreSQL, Temporal, Kubernetes, API, and log readback.
3. This operating design and the owning service READMEs.
4. Historical commits and archived design documents.

The design describes required behavior. It must never be used to claim that behavior is already deployed. Every
production claim needs current runtime proof against the active snapshot.

## Agent Trust and Reverification

Atlas is a production navigation surface when its live index agrees with the requested Git ref. Git remains the source
of truth.

1. Search Atlas first when repository guidance requires it.
2. Check the returned commit and degradation fields before relying on a result.
3. Verify high-impact findings against the returned exact commit with `git show`, `rg`, or direct file reads.
4. If Atlas misses a known symbol, returns a deleted path, silently falls back from semantic search, or serves source
   from a different commit, report that contradiction rather than working around it invisibly.
5. If `origin/main` and the indexed commit differ, wait for the single reconcile workflow or run the operator verifier;
   do not start a duplicate reconcile.
6. Do not infer corpus completeness from `atlas_stats`, sampled health, pod readiness, Argo health, or a few successful
   queries. Only `atlas:verify` checks the complete contract.

The dated execution record in the production design closed the initial rollout gate. Any later contradictory live
evidence takes precedence and reopens it.

## Operator Commands

All commands target the one existing Atlas corpus. There is no backup, shadow index, or fallback corpus.

```bash
# Start exactly one full-tree reconciliation and wait for its Temporal result.
bun run atlas:rebuild --repository proompteng/lab --ref main

# Independently compare origin/main, every eligible Git blob, PostgreSQL, search, source preview, and latency.
bun run atlas:verify \
  --repository proompteng/lab \
  --ref main \
  --database-url "$DATABASE_URL" \
  --base-url "$ATLAS_BASE_URL"
```

Production GitOps enables exactly one Bumba GitHub event consumer. During a future destructive rebuild, disable that
same consumer through GitOps and leave it disabled until `atlas:verify` exits zero against the live image and indexed
commit. If `origin/main` advances, let the existing reconcile finish and verify again. Re-enable the same consumer in Git
only after the final verification passes; never add a second consumer or corpus.

The rebuild writes bounded file batches while repository status is `building`, so all search surfaces return unavailable
until the final complete-manifest transaction changes the status to `ready`. Temporal heartbeats detect a dead worker in
90 seconds and carry the build ID, commit, and persisted progress into the retry. A database build lease fences concurrent
writers, and pending GitHub events are serialized per repository.

Both MCP and `GET /api/search` use the same fail-closed code-search implementation. The only agent search tool is
`atlas_code_search`; direct indexing tools, partial backfill CLIs, and the legacy enrichment-search tool are not production
entrypoints.

Jangar idempotently installs the trusted `pg_trgm` extension as the owner of its existing application database before
validating extensions and running migrations. New clusters also install it through `postInitApplicationSQL`. PostgreSQL
documents `pg_trgm` as a trusted extension that a non-superuser with `CREATE` privilege on the database may install.

The application migration truncates the Git-derived corpus under `atlas.file_keys` and `atlas.symbols`, while preserving
repository identities plus `github_events` and `ingestions` operational history. It then changes the empty embedding
column to `vector(1024)` and creates the unique, trigram, and HNSW indexes. Git remains the recovery source.

See the PostgreSQL documentation for [trusted extension installation](https://www.postgresql.org/docs/current/sql-createextension.html)
and [`pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html).
