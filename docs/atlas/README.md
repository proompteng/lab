# Atlas Code Search

Status: Current operating entrypoint. The repair is implemented on `codex/atlas-code-search-repair`; Atlas is still
untrusted until that change is merged, deployed, rebuilt, and every live acceptance gate passes.

Atlas is the repository ingestion, indexing, and search system used by Jangar, Bumba, Codex, and other agents. Its job
is not merely to return plausible code. It must identify the exact indexed repository snapshot, search the complete
eligible corpus, exclude deleted content, expose degradation honestly, and let an operator reproduce every result from
Git and database evidence.

The implementation plan repairs the existing Atlas schema and tables in place. The invalid corpus will be truncated and
rebuilt from Git during a maintenance window.

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

## Agent Use Until Live Proof

Atlas remains a navigation aid while the production acceptance gates are open.

1. Search Atlas first when repository guidance requires it.
2. Treat returned paths and line ranges as leads, not proof.
3. Verify important results against the exact requested ref with `git show`, `rg`, or direct file reads.
4. If Atlas misses a known symbol, returns a deleted path, silently falls back from semantic search, or serves source
   from a different commit, report that contradiction rather than working around it invisibly.
5. Do not infer corpus completeness from `atlas_stats`, sampled health, pod readiness, Argo health, or a few successful
   queries.

No agent should claim that Atlas works correctly until every gate in the production design's Definition of Done is
proven on the live active snapshot.

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

The GitOps manifest intentionally sets `BUMBA_GITHUB_EVENT_CONSUMER_ENABLED=false` during cutover. Leave it disabled
until `atlas:verify` exits zero against the live image and indexed commit. If `origin/main` advances, run rebuild and
verification again. Re-enable the same consumer in Git only after the final verification passes.

Jangar idempotently installs the trusted `pg_trgm` extension as the owner of its existing application database before
validating extensions and running migrations. New clusters also install it through `postInitApplicationSQL`. PostgreSQL
documents `pg_trgm` as a trusted extension that a non-superuser with `CREATE` privilege on the database may install.

The application migration truncates the Git-derived corpus under `atlas.file_keys` and `atlas.symbols`, while preserving
repository identities plus `github_events` and `ingestions` operational history. It then changes the empty embedding
column to `vector(1024)` and creates the unique, trigram, and HNSW indexes. Git remains the recovery source.

See the PostgreSQL documentation for [trusted extension installation](https://www.postgresql.org/docs/current/sql-createextension.html)
and [`pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html).
