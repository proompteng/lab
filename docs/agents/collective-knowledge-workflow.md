# Agents collective knowledge

[The Agents knowledge bundle](ontology/agents-knowledge.json) is the reviewed Git source for platform acronyms,
operating rules, and saved SQL analyses. It is advisory: verify material claims against current source and live evidence.
Keep application-specific knowledge with the owning application.

## Start an AgentRun: read only

1. Use the run's configured read-only Auto Ontology MCP tools. The canonical private endpoint is
   [Auto Ontology MCP](https://auto-ontology-mcp.ide-newton.ts.net/mcp); use the configured gateway if provided.
   Search terms with `search_terms` (use `Agents policy:` for operating rules) and read a match with `get_term`.
   Consult `check_answerable` before asking a bounded, task-specific question with `ask_question`.
2. If using REST instead, the [web origin](https://auto-ontology.ide-newton.ts.net) serves `GET /api/terms?query=…`,
   `GET /api/acronyms`, and `GET /api/custom-analyses?query=…` with the authorized read-only identity. Do not create
   credentials or connect directly to the source database from a run. If the catalog, connection, or permissions are
   unavailable, use the checked-out bundle and owning source; do not infer that missing results establish a fact.

## Finish an AgentRun: propose and retain

Propose a delta only for reusable, verified knowledge about the Agents platform. In the checkout where the claim was
verified, create a JSON draft with a short, sanitized verification note saying what was checked. Summarize the
evidence; do not copy prompts, transcripts, logs, SQL results, credentials, connection URLs, or personal data.
Example `draft.json`:

```json
{
  "verificationNote": "Checked the registered migration and confirmed the terminal phase is persisted.",
  "acronyms": [{ "name": "Terminal phase", "description": "The observed end state of an AgentRun." }]
}
```

Include any nonempty combination of `acronyms`, `rules`, and `customAnalyses`. Entries use `name` and `description`;
analyses also require a single `sql` string. Keep queries bounded and project explicit columns (aggregate `COUNT(*)`
is fine). Use schema-qualified tables, SELECT subqueries or nonrecursive SELECT CTEs, and approved read-only functions.
Saved analyses cannot require SQL parameters.

With locked Bun dependencies installed, emit the proposal to a **new** file in an existing directory:

```sh
bun run packages/scripts/src/agents/emit-knowledge-delta.ts \
  --input draft.json --output knowledge-delta.json
```

The emitter fills in `kind`, `version`, and `sourceCommit`. If the draft already pins a commit, it must be the full SHA
of the emitter checkout's `HEAD`; branch names, abbreviated SHAs, and other commits are rejected. The emitter
rejects unknown fields and recognized credential, personal data, and prompt patterns. It binds saved analyses
against an in-memory copy of the registered Agents migrations without executing them or contacting a database
service. On success it writes canonical JSON with sorted keys and a final newline, without overwriting an existing
file. On rejection it does not publish a file or echo the draft.

Before attaching an existing proposal to a PR, check it without writing. Use the emitter from the checkout pinned
by the proposal:

```sh
bun run packages/scripts/src/agents/emit-knowledge-delta.ts --check --input knowledge-delta.json
```

Check mode rejects noncanonical bytes as well as invalid contents. Pattern checks cannot recognize all personal
data or unlabeled prompts; review the file for disclosure and verify its claims before sharing it.

Retain the file using the run's existing artifact mechanism and hand off the artifact reference with the completed run
ID. For opt-in Codex runs, declare an `AgentProvider.spec.outputArtifacts` entry with name `knowledge-delta`, an agreed
workspace path (such as `/workspace/.agent/knowledge-delta.json`), and a unique per-run object key using the authorized
artifact storage. Configure that keyed output only for runs expected to produce the file: the Codex runner uploads
declared outputs on success, and a missing keyed file fails the upload. A local tmpfs path is not retained evidence.
Other providers can use the same JSON contract and their configured artifact channel.

## Curate and publish

1. Check the terminal run and artifact reference. Resolve the proposal's commit and reproduce or inspect its stated
   verification. Review for correctness, scope, and disclosure before selecting inputs. Treat generated proposals as
   untrusted; neither a valid schema nor a green run constitutes approval.
2. On a branch from the current reviewed bundle, pass the approved files as repeated `--input` flags or a directory
   containing only approved proposals (top-level `.json` files). Run `dry-run`, then re-run with `--mode write` and
   inspect the diff. Identical entries replay without changing existing evidence; conflicting names or reused SQL
   under another name reject the batch. The curator writes only the local bundle, never queries production, and
   validates the entire resulting bundle against a disposable PostgreSQL schema built from the Agents migrations.
   Open a Git PR with the run references and verification. Only publish from the reviewed merge.
3. An authorized catalog publisher uses the [Auto Ontology 1.3.0 API](https://github.com/NVIDIA/auto-ontology/blob/v1.3.0/docs/openapi/auto-ontology-api.json)
   or equivalent UI, with the existing least-privileged read-only connection to the `agents` database on `agents-db-next`.
   Stop if that connection or the required catalogued columns are missing. Match existing entries by exact name and
   apply only reviewed differences. The Git-only `provenance` field is not sent to the catalog:
   - **Acronyms:** create with `POST /api/acronyms` (`name`, `description`) or update the matched ID with `PATCH /api/acronyms/{id}`.
   - **Operating rules:** publish as glossary terms named `Agents policy: <name>` with the rule as the description.
     For a new term, import a native model fragment containing `semantic_layer.terms` with `id` (stable, e.g.
     `lab.agents.policy:<name>`), `name`, and `description`, through `POST /api/model/import?replace=false`. Patch an
     existing term by its live ID. The `/api/rules` API is for search/tagging rules, not policy prose.
   - **Custom analyses:** `POST /api/custom-analyses/validate` with `sql`; publish `name`, `description`, and `sql`
     with `POST /api/custom-analyses` or `PUT /api/custom-analyses/{analysis_id}`. Confirm validation resolved the
     intended catalogued source. Never substitute the application database owner's credentials.
4. Read back the exact names, descriptions, and saved SQL from their list/get endpoints. Run one bounded read-only
   question against the changed knowledge as appropriate. On mismatch, stop and reconcile against the reviewed Git
   revision; do not use a catalog-wide replacement or reset.

## Database scope and limits

Treat [the registered migrations](../../services/agents/src/server/migrations/) as the schema authority.
`agents_control_plane.resources_current` is the retained AgentRun cache used by the failure and timing rollups;
it is not a complete execution history. `public.agent_runs` is an intake projection, `agents_codex.runs` is
the Codex-specific projection, `agents_comms.agent_messages` holds communications, and
`public.agent_run_relay_submissions` is distinct from `public.agent_run_rerun_submissions`. Engineering notes are
`memories.entries`; `last_accessed_at` measures last retrieval, not reuse counts or run attribution.

The duration analysis reports token totals only where runner telemetry was retained and does not estimate or record
billed USD. For a cost estimate, combine the applicable input, cached input, cache-write, and output counts with an
approved rate card for that provider, model, and period. Never interpret unknown usage or cost as zero.
