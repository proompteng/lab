# Cross-bundle Auto Ontology audit

Run the auditor before publishing or reviewing knowledge bundles, especially after moving or deleting cited files.
It reads local files and parses saved PostgreSQL queries; it does not execute them, contact GitHub or the catalog,
require credentials, or update any files.

## Run the audit

From the repository root, install dependencies with `bun install --frozen-lockfile` and run:

```sh
bun run packages/scripts/src/agents/audit-ontology-bundles.ts --format markdown
```

Without a selection the auditor discovers `docs/**/ontology/*-knowledge.json` under the working directory. Use
`--root <dir>` to select another checkout and `--bundles <path> ...` to replace discovery with an explicit list of
regular files. Relative paths are resolved against the audit root, not the current directory or the bundle directory.

```sh
bun run packages/scripts/src/agents/audit-ontology-bundles.ts \
  --bundles docs/agents/ontology/agents-knowledge.json docs/bayn/ontology/bayn-knowledge.json \
  --format json --fail-on-error
```

Markdown is the default. Both formats report findings without changing the exit status by default. With
`--fail-on-error`, any finding sets exit status `1` after the full report. Usage or root/discovery failures exit `2`.
A valid root with no matching bundles reports zero bundles and exits `0`; check the scanned file list when auditing
a checkout for the first time.

## Interpret findings

- `acronym-collision`: One acronym `name` or `aliases` string occurs in multiple files, ignoring case and surrounding
  whitespace. Review all listed definitions with the owning teams, even when intentional. Repetition within one file
  is not a cross-bundle collision.
- `citation-drift`: A repository citation no longer points to a regular file inside this checkout. Verify the current
  path locally, then update or remove stale evidence in a separate bundle change.
- `possible-secret`: A field, property name, or parsed SQL value resembles a credential or database URL. Inspect the
  indicated location locally, remove the value, and follow the owning rotation procedure if it was committed or exposed.
- `unsafe-sql`: A `sql` field is outside the supported PostgreSQL subset: one read-only `SELECT`, with optional read-only
  CTEs. Writes, data-changing CTEs, `SELECT INTO`, row locks, and non-allowlisted functions are not supported.
- `bundle-read-error`, `invalid-json`, `invalid-bundle`: Check that the selected file is readable UTF-8 JSON with unique
  object keys, the version-1 generic or Bayn bundle sections, and expected acronym/analysis fields. Other files are
  still audited.

The citation check recognizes repo-relative filenames in rules and evidence (`sources`, `evidence`, `citations`,
`provenance`, `verificationNote`), including inline Markdown links and code spans. It also recognizes
`proompteng/lab` GitHub `/blob/<ref>/<path>` links. For ambiguous paths such as filenames containing spaces, use a
pinned blob link or, if your bundle schema allows it, a structured `path` or `filePath` field. Line anchors and
fragments do not affect existence. A pinned link's **path** must exist in the current checkout, even if it still
resolves at the historical commit. The auditor does not check the target's contents, line numbers, external URLs,
or links to issues and PRs.

Reports omit cited text, terms, SQL, credential values, and parser diagnostics. They identify a bundle and JSON field
instead. In JSON, `locations[].bundle` indexes `bundles`; array indices are zero-based, `{#n}` points to the one-based
property position for an unprinted key, and an optional `offset` is the one-based character position in a citation
field. Bundle paths that look sensitive or cannot be safely displayed are redacted. Credential detection is heuristic;
use placeholders such as `[REDACTED]` or a variable reference instead of literal values or database URLs, and do not
copy source text into a public report.

The auditor complements [bundle validation](../../../packages/scripts/src/agents/validate-ontology-bundles.ts).
It does not replace canonical JSON, migration/relation, live catalog, or least-privilege checks. An audit never
authorizes catalog writes, database access, or a trading-policy change.
