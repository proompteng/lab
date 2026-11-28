# CI and release Auto Ontology knowledge

[CI release knowledge](ci-release-knowledge.json) is the version-1 glossary and advisory rule bundle for Galactic's CI,
ARC self-hosted runners, and Kargo image delivery. [Release automation](../../release-automation.md) and
[AGENTS.md](../../../AGENTS.md) remain authoritative. Catalog rules are saved searches with tags, not CI gates or
promotion policies.

## SQL source and activation

The bundle targets the existing `agents` database connection on `agents-db-next`. The
[Agents migration](../../../services/agents/src/server/migrations/20261128_ci_audit_projection.ts) exposes only the
`ci_audit` tables to the existing `agents_audit_ro` login; it adds no raw `public.*` access, write access, or new Auto
Ontology credentials.

- `ci_audit.workflow_runs`: one row per GitHub `run_id`, representing its latest collected completed attempt.
  `workflow_name` is the enrolled workflow filename. `duration_seconds` uses attempt timing, not time between reruns.
- `ci_audit.job_runs`: one row per completed `job_id` across retained attempts. Join on `run_id` for branch and
  revision, not to identify the job's attempt. `duration_seconds` is execution time when available.
- `ci_audit.failure_clusters`: up to 100 groups of jobs that failed in the 24 hours ending at `synced_at`. Groups
  use workflow, job name, and failure category; `sample_run_id` is the most recent failed job's run.

The collector promotes the first observed failed step's bounded phase to `failure_category`, or uses `unattributed`
if no failed step is available. Timeouts and startup failures keep their conclusion as the category; cancellations
and successes are not failures. The projection carries operational identifiers and timings, not actors, raw logs, or
step details. A missing row can mean delayed or disabled projection. CI outcomes do not establish release promotion
or deployment.

1. With separate approval to enable writes, provision the dedicated non-owner `ci_audit_writer` login through the
   approved credential path. Create it before the migration or have the database owner replay only the guarded
   grant block afterward. Keep the existing `agents_audit_ro` login unchanged.
2. Follow the [collector's opt-in instructions](../../../argocd/applications/observability/ci/README.md#optional-sql-projection).
   The committed deployment intentionally leaves `CI_AUDIT_DATABASE_URL` unset and has no new Secret or SealedSecret.
3. On the **existing** Auto Ontology connection, refresh discovery and include `ci_audit` alongside `agents_audit` if
   the connection uses a schema filter. Verify all three relations are readable as `agents_audit_ro`, and that
   writes and raw Agents table reads are still denied. Do not add another connection.
4. Create the `ci-release canonical rule` tag if absent (25 characters). Use the
   [reviewed bundle publication procedure](../../agents/ontology/README.md#preview-and-publish) with the CI bundle
   path below. Read back the entries and run a bounded analysis before calling the catalog live.

## Glossary ownership

Acronym names are case-insensitive global catalog identities. Use the canonical `ARC` (Actions Runner
Controller), `Kargo` (image promotion), and `Freight` (the immutable artifact record) entries from the
[Agents bundle](../../agents/ontology/agents-knowledge.json); this bundle does not register them again. Compare new
names against Agents, [Bayn](../../bayn/ontology/bayn-knowledge.json), the Galactic platform (Wave 19I), and
observability (Wave 19Q) before adding them.

## Offline validation

From the repository root with Bun and workspace dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/ci/ontology/ci-release-knowledge.json --mode dry-run
bun packages/scripts/src/agents/validate-ontology-bundles.ts
```

Dry-run validates the bundle without credentials, network calls, or catalog writes. The offline validator also
checks that analysis relations exist in the Agents migrations. Review names across bundles and check descriptions
for sensitive data; offline validation does not inspect the live catalog or prove a release.
