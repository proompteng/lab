# Jangar Atlas Auto Ontology

[ONT-2's knowledge bundle](jangar-knowledge.json) defines four read-only analyses for Atlas: indexing freshness,
file and language coverage, chunk embedding lag, and GitHub event intake. These are diagnostics from a standby
snapshot, not proof that Atlas matches Git. See the [Atlas verification contract](../../atlas/README.md).

## Data boundary

The [Jangar migration](../../../services/jangar/src/server/migrations/20261128_jangar_audit_reader_grants.ts) exposes
only seven views in `jangar_audit`: repositories, ingestions, file versions, chunk coverage, GitHub events, symbols,
and file edges. Views use opaque IDs, counts, timestamps, and allowlisted categories. They exclude repository names,
file paths, symbol names and signatures, raw JSON, error strings, source text, embeddings, GitHub payloads and
sender identities, and all application tables. Unknown category values are grouped rather than returned verbatim.
An embedding count measures presence, not model or dimension validity.

## Onboarding after review

1. Provision `jangar/jangar-audit-ro-db` through the approved secret-sync path as a `kubernetes.io/basic-auth`
   Secret for `jangar_audit_ro` with the `cnpg.io/reload: "true"` label. Sync the managed role before the Jangar
   migration runs on the primary. A privileged bootstrap can create the role as `NOLOGIN`; CNPG owns login and
   credentials. If the migration was recorded before the role existed and the database owner could not create it,
   reapply its guarded SQL as the database owner after CNPG provisions the role. Do not edit migration history.
   The migration removes database `CREATE` and `TEMPORARY` from `PUBLIC`; verify any clients that need temporary
   tables keep explicit privileges. Do not add other role memberships to the audit login.
2. Connect Auto Ontology to `jangar-db-ro.jangar.svc.cluster.local:5432`, database `jangar`, using
   `jangar_audit_ro` and verified CNPG TLS. The new ingress rule permits TCP 5432 from `auto-ontology` to
   replica pods only. It does not select the primary or override any other NetworkPolicy. Verify
   `pg_is_in_recovery()` is true, reads of the seven views succeed, and reads of raw Atlas and application tables
   and writes, schema creation, and temporary tables are denied. Catalog only `jangar_audit`.
3. Create the `jangar canonical rule` tag before publishing. Follow the reviewed apply procedure in the
   [Auto Ontology sync guide](../../agents/ontology/README.md) with this bundle. Do not use the application owner
   or publish credentials.

To preview from the repository root without credentials or writes:

```sh
bun run packages/scripts/src/agents/validate-ontology-bundles.ts
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/jangar/ontology/jangar-knowledge.json --mode dry-run
```
