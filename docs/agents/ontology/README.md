# Agents Auto Ontology sync

[Agents knowledge](agents-knowledge.json) is the reviewed source for the Agents catalog. The [Wave 14A bundle](https://github.com/proompteng/lab/pull/16422)
analyses use the `agents_audit` schema here, rather than the underlying tables. Keep that boundary when reconciling
curator changes: Auto Ontology can read the projected fields but cannot read raw prompts, messages, note text,
resource snapshots, payloads, or `public.memory_resources.connection_secret`. Terminal timing uses observed
timestamps, token totals cover only observed telemetry, and billed USD is unknown.

## Onboard `agents-db-next` after #16426

1. After [#16426](https://github.com/proompteng/lab/pull/16426) merges, reconcile the role in a separate reviewed
   GitOps change. Provision `agents/agents-audit-ro-db` through the approved secret-sync path as a
   `kubernetes.io/basic-auth` Secret with username `agents_audit_ro`, a dedicated password, and label
   `cnpg.io/reload: "true"`. Add this exact stanza under `spec` in
   [postgres-cluster.yaml](../../../argocd/applications/agents/postgres-cluster.yaml), merging into any existing
   `managed.roles` list:

   ```yaml
   managed:
     roles:
       - name: agents_audit_ro
         login: true
         inherit: false
         superuser: false
         createdb: false
         createrole: false
         passwordSecret:
           name: agents-audit-ro-db
   ```

   CNPG defaults the role to present, without replication or bypass-RLS privileges. Verify those flags and that
   there are no role memberships. The role must not own the database, schemas, or relations.

2. Sync the role before deploying the [Agents migration](../../../services/agents/src/server/migrations/20261128_agents_audit_reader_grants.ts).
   If Kysely already recorded it while the role was absent, have the database owner run its guarded `DO` block on
   the primary through the approved administration path. It is safe to rerun; do not edit migration history.
   The migration revokes `PUBLIC`'s database `CREATE` and `TEMPORARY` privileges and public-schema `CREATE` so
   the audit login cannot get those rights indirectly. The `agents` database owner retains its rights; check
   for other clients that legitimately need temporary tables before rollout and grant only those identities.
3. Verify the reviewed NetworkPolicy and `agents-db-next` endpoints with the
   [Galactic Kubernetes context](../../runbooks/galactic-kubernetes-access.md). The new ingress rule selects only
   that cluster's pods and allows TCP 5432 from the `auto-ontology` namespace. Policies are additive: the existing
   Agents traffic-neutral rollout policy still allows other paths. This rule does not isolate the cluster or make
   PostgreSQL read-only; the login and relation grants enforce the data boundary.
4. In [Auto Ontology](https://auto-ontology.ide-newton.ts.net), open **Settings → Connections** and test PostgreSQL
   with the approved password and verified CNPG TLS settings. Use `agents-db-next-r.agents.svc.cluster.local:5432`,
   database `agents`, user `agents_audit_ro`, and ingest only schema `agents_audit`. The `-r` Service can select a
   primary on a single-instance cluster; use `-ro` if a verified standby is available. Never use the application
   owner's credentials. As `agents_audit_ro`, verify `SELECT COUNT(*) FROM agents_audit.agent_run_activity` succeeds,
   reads of `public.memory_resources`, `public.agent_runs`, and `agents_control_plane.resources_current` are denied,
   the audit views have no write or grant privileges, and database `CREATE`/`TEMPORARY` and schema `CREATE` are denied.
   Check only the seven audit views were catalogued before running apply. In **Settings → Tags**, create
   `agents canonical rule` (matching `ruleTag` in [agents-knowledge.json](agents-knowledge.json); Auto Ontology 1.3.0
   enforces a 25-character maximum on tag names) if absent.

## Preview and publish

From the repository root with Bun dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/agents/ontology/agents-knowledge.json
```

This defaults to `--mode dry-run`: no credentials, HTTP, or writes. It checks the versioned bundle, common
credential patterns, and a single read-only PostgreSQL SELECT per analysis, including SELECT CTEs. It does not
execute queries or prove that an external schema exists. Use explicit columns (`COUNT(*)` is allowed), approved
built-ins, bounded queries, and schema-qualified relations. The 1.3.0 catalog resolves SQL by schema name across
databases, so apply rejects any referenced schema that is missing or ambiguous in the catalog.
Always review the text for sensitive content; pattern checks do not detect every possible secret.

For a reviewed apply, inject `AUTO_ONTOLOGY_API_TOKEN` from the approved secret manager. Use the authenticated
[1.3.0 frontend API](https://github.com/NVIDIA/auto-ontology/blob/v1.3.0/docs/openapi/auto-ontology-api.json),
not the private backend or MCP port. The token needs permissions to list the catalog and manage acronyms, rules,
and analyses. Keep credentials out of shell history, arguments, logs, and artifacts.

```sh
export AUTO_ONTOLOGY_API_URL=https://auto-ontology.ide-newton.ts.net
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/agents/ontology/agents-knowledge.json --mode apply
```

Inside the cluster, `http://frontend.auto-ontology.svc.cluster.local:3000` is also accepted. Apply checks the
catalogue, validates all analyses it would change before the first write, and creates or updates changed entries.
It never writes the source database or deletes catalog entries. Re-read the catalog and run one bounded read-only
question; an unchanged rerun must report `writes: 0`. Run one publisher at a time. On a timeout or conflict,
re-read the live state before retrying: the API does not provide a bundle-wide transaction.

## Nightly sync and alerts

The [Agents CronJob](../../../argocd/applications/agents/auto-ontology-sync-cronjob.yaml) applies the Git-reviewed
bundle at 07:15 UTC. Kustomize mounts this directory's JSON read-only and uses the same digest-pinned controller
image as the Agents Deployment. The job reads no database credentials and has no Kubernetes API token. It writes
only catalog metadata through the authenticated frontend; the source database remains read-only.

Before the first run, verify onboarding above, including the catalogued audit views, canonical rule tag and API
permissions of the existing `auto-ontology-mcp-token` Secret. Sync the reviewed
[kube-router policy](../../../argocd/applications/kube-router/safety-policies.yaml) before the Agents release so its
rollout allow-all does not override the job's frontend-and-DNS allowlist. Release the controller image, bundle and
CronJob together through the [Agents Kargo Stage](../../release-automation.md). Verify the rendered digest and
mounted bundle, then check `.status.lastSuccessfulTime` and the Job's log counts after the first scheduled run.

The gateway alert means there were zero available replicas for five minutes; inspect the gateway Deployment and
pod events in `agents`. For a sync alert, inspect `kubectl -n agents describe cronjob auto-ontology-sync`, the
owned Job conditions, and `kubectl -n agents logs job/<job-name>`. A terminal Job failure alerts until a newer
success; failed pods still being retried do not alert. Staleness is measured from the last success or, before the
first success, CronJob creation. Do not dump the Secret or pod environment.

If a bad bundle or image must be rolled back, suspend the schedule through reviewed GitOps, let any active Job
finish, and restore the previous bundle and image together through the release path. Leave the schedule suspended
if the restored image predates the sync CLI. Keep the egress exclusion in place while sync pods exist. Do not run
a manual publisher concurrently with the nightly job.

## Other domains

Pass any reviewed version 1 JSON bundle with `dataSource`, `acronyms`, `rules`, and `customAnalyses`. Each item has
`name` and `description`; analyses also have `sql`. If the stable source key differs from the onboarded PostgreSQL
database name, set `database`, as in the Agents bundle. Optional `provenance` stays in Git. Acronyms and analysis
names are global identities: use distinct names for distinct meanings and keep shared acronyms consistent across
bundles. A rule is a database-scoped saved search/tag, not an enforcement policy. Its optional `searchTerm`
defaults to its name; its description is shown in the rule display name. Precreate the canonical rule tag (`ruleTag`,
or `<dataSource> canonical rule` when `ruleTag` is omitted) when there are rules; Auto Ontology 1.3.0 caps tag names at
25 characters, so set `ruleTag` whenever `<dataSource> canonical rule` would exceed that limit. The API can rename these
rules but cannot retarget their search or tags. Reconcile such drift as a catalog operator rather than deleting and
recreating rules from the sync.
