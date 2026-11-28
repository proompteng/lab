# Auto Ontology operations

The Git bundles are reviewed catalog inputs, not runtime policy or grants. An AgentRun may read the catalog and
propose knowledge; an authorized operator publishes only from a reviewed revision. The CI validator never connects
to Auto Ontology or to a source database.

## Verify readiness

1. Verify the [Galactic context and identity](../runbooks/galactic-kubernetes-access.md). If the
   [Agents MCP gateway](auto-ontology-mcp.md) is enabled, check its Pods are Ready:

   ```sh
   kubectl -n agents get pods -l app.kubernetes.io/name=agents-auto-ontology-mcp-gateway
   ```

   The probe checks access to the authenticated Auto Ontology frontend, not whether the catalog is usable.

2. In a new authorized Codex canary AgentRun, call `check_readiness`. Require `ready: true` and the intended database
   in `databases`. A ready catalog has been ingested and compiled; this does not prove SQL connectivity.
3. Use `search_terms` or `list_custom_analyses` to read back the expected entry. Check `check_answerable` and then run
   one bounded question against an approved fixture to verify the source connection and answer. Stop on a mismatch;
   inspect connection, ingestion, or compilation rather than broadening the read-only grants.

## Validate, preview, and apply

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts --filter @proompteng/scripts
bun packages/scripts/src/agents/validate-ontology-bundles.ts
```

Commit the canonical JSON layout from the repository's Oxfmt configuration. Use alphabetical object keys for
version-1 Agents-style bundles and deltas, and the owning schema's field order for Bayn's versioned format.
Preserve array order. The gate checks common disclosure patterns, a single read-only PostgreSQL statement, and
relation names from forward SQL files and static SQL templates in the Agents and Bayn migrations. Keep relation
DDL statically named and drop dependent views explicitly rather than by cascade. The gate does not bind columns,
execute analyses, or replace the publisher's live preflight.

Run a sync tool only from a reviewed revision that contains the tool and its seed. For
[Agents](ontology/README.md#preview-and-publish), preview without credentials, HTTP, or writes:

```sh
bun packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/agents/ontology/agents-knowledge.json --mode dry-run
```

To publish, follow the [Agents onboarding and apply procedure](ontology/README.md), including verification that
only the approved audit views are catalogued, then rerun with `--mode apply` and the approved publisher identity.

For [Bayn's seed sync](https://github.com/proompteng/lab/pull/16424), install its locked dependencies and use a
non-root operator environment with PostgreSQL 18 `initdb` and `postgres` on PATH:

```sh
bun services/bayn/tools/sync-auto-ontology.ts --mode dry-run
```

Dry-run binds the SQL against a disposable migrated database; it needs no credentials and makes no HTTP requests.
For an approved apply, inject `AUTO_ONTOLOGY_API_TOKEN` from the secret manager. Use the publisher token, not the
sealed read-only gateway token, and use the HTTPS frontend, never the private backend:

```sh
AUTO_ONTOLOGY_API_URL=https://auto-ontology.ide-newton.ts.net bun services/bayn/tools/sync-auto-ontology.ts --mode apply
```

Apply repeats the offline check and preflights the intended onboarded catalog before any write. Read back the changed
entries; an unchanged second run should report zero writes. If apply times out or partially succeeds, read back and
reconcile the catalog before retrying.

[Agents delta curation](https://github.com/proompteng/lab/pull/16422) uses `--mode dry-run` for preview and
`--mode write` to update the local bundle only. This is not catalog apply; publish only the reviewed seed.

## Review a knowledge-delta PR

- Check the originating run and the proposal's `sourceCommit`, verification note, and any evidence links. Resolve the
  commit against fresh `origin/main` and reproduce or inspect the claim. Do not publish directly from an artifact.
- Confirm each claim belongs to the owning service. Check the SQL projection, limits, bind parameters, and table scope
  against its migrations and approved read role. Reject raw results, logs, prompts, account identifiers, personal
  data, and credentials even if the pattern check passes.
- Incorporate only accepted entries into the owning seed, run its dry-run plus the repository validator, and inspect
  the Git diff before approval. Catalog apply follows review, not CI alone.

## Rotate the sealed gateway token

1. Use the approved Auto Ontology account to issue a replacement with the same read/chat scope. For a routine rotation
   keep the old token until the new Pods are verified; for suspected compromise revoke the old token immediately.
2. Follow the [gateway sealing procedure](auto-ontology-mcp.md#activate-in-gitops) for Secret
   `agents/auto-ontology-mcp-token`, key `AUTO_ONTOLOGY_API_TOKEN`. Confirm the context and seal with tracing off.
   Commit only ciphertext, never the token, a rendered Secret, or a command argument containing either plaintext
   credentials or a password-bearing URI.
3. Sync the reviewed SealedSecret through GitOps and roll the gateway through GitOps so both Pods read the new
   environment variable. A Secret update alone does not refresh running containers. Confirm readiness and the canary
   read above, then revoke the retired token if not already revoked. Never copy the API token into an AgentRun.
