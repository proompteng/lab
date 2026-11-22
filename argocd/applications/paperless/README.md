# Paperless-ngx

Private document archive for the `galactic` cluster, including built-in AI
suggestions and document chat backed by the existing Flamingo inference service.

## Components and access

- UI: `https://paperless.ide-newton.ts.net` (Tailscale only, no public ingress).
- Paperless `3.5.1`: one **rootless** Pod with 1 CPU / 2 GiB requested and
  4 CPU / 4 GiB limited. Two task workers × two OCR threads, with English OCR.
  Kubernetes Service links are disabled to avoid injecting the `PAPERLESS_PORT`
  service URI into Granian's numeric listening-port setting.
- CloudNativePG `paperless-db`: PostgreSQL 18, two instances, 10 GiB RBD each.
- `paperless-valkey`: authenticated Valkey 9, AOF persistence on 2 GiB RBD.
- Tika and Gotenberg: isolated internal services to support Office documents
  and `.eml` files. Gotenberg disables Chromium JavaScript for conversions.
- RBD (`rook-ceph-block`): 100 GiB `paperless-media`, 10 GiB `paperless-data`,
  5 GiB `paperless-consume`. Export and temporary working directories are
  ephemeral, 10 GiB each. Increase these only for actual workload needs.

## Flamingo integration

Native Paperless AI is enabled using the `openai-like` backend:

```text
PAPERLESS_AI_LLM_ENDPOINT=http://flamingo.flamingo.svc.cluster.local/v1
PAPERLESS_AI_LLM_MODEL=qwen38-flamingo
```

Flamingo supplies text generation for suggestions and chat; Paperless uses
`sentence-transformers/all-MiniLM-L6-v2` locally for document embeddings.
The embedding model is downloaded on first use and cached on the `data` PVC.
There is no external hosted LLM provider or additional inference deployment.
The endpoint has no provider API authentication; `flamingo-local` is a dummy
key required by the OpenAI-compatible client. Paperless' admin can change AI
settings in its UI; those database settings override the manifest environment.

Do not point document embeddings at Flamingo's text-only chat model.

## Initial credentials

Three independent generated passwords are provisioned once into
`Secret/paperless-runtime` through External Secrets; none are committed. The
superuser starts as username `greg` and placeholder email
`admin@paperless.local`.

```sh
kubectl -n paperless get secret paperless-runtime \
  -o jsonpath='{.data.PAPERLESS_ADMIN_PASSWORD}' | base64 --decode
```

Set your actual email and rotate the initial password after logging in.
Keep `PAPERLESS_SECRET_KEY`, the PostgreSQL app secret, and the database when
restoring; rotating the secret invalidates sessions and signed artifacts.

## Agent Shell API access

Agent Shell and Agent Shell Tunnel share the same MCP server and Paperless client.
The [tool guide](../../../docs/agents/agents-shell-paperless.md) describes search,
document reading, upload/download, metadata edits, task tracking and native AI
suggestions. The API remains internal; ingress permits only Tailscale and the
Agent Shell Pod selector in the `agents` namespace. `PAPERLESS_ALLOWED_HOSTS`
includes the internal service DNS, and a Pod annotation changes with that setting
so Kubernetes recreates the environment-reading consumer.

The `paperless-agent-bootstrap` PostSync hook uses the same pinned image as the
application to reconcile a dedicated `agents-shell` account and `Agent Shell`
group. The account has an unusable login password, no staff/superuser privileges,
document view/add/change, task and metadata view, and tag/correspondent/document
type creation. It has no delete, user-management, configuration or workflow-edit
permissions. Its `Agent Shell document access` workflow adds group view/change
grants to future ingested documents while preserving their owners and grants.
The initial archive was empty; bootstrap does not migrate existing document ACLs.
Metadata owned by other accounts still needs ordinary Paperless sharing.

External Secrets generates a 40-character API token once into the retained
`paperless-agent-api` Secret. A dedicated reader ServiceAccount has only `get`
access to that named Secret. Its namespaced Kubernetes SecretStore copies only
the token to `agents/agents-shell-paperless`, mounted read-only in the MCP server.
No Paperless admin password or database credential is delivered to Agent Shell.
The server reads the mounted token for each request so Secret refresh needs no
Pod restart. To rotate it, update the retained source Secret through the approved
secret-management path, run a normal Paperless sync to bind it to the same API
account, and verify ESO refresh and authenticated tool status. Preserve the source
Secret with the database during recovery.

Bootstrap is idempotent and fails if the managed user has unexpected privileges,
a login password, or conflicting identity details. Review changed workflow rules
instead of overwriting unrelated user policy. Reverting the integration's source
changes removes tool wiring; explicitly disable the API account to revoke access.

## Validation

```sh
python3 argocd/applications/paperless/validate.py
python3 -m unittest discover -s argocd/applications/paperless -p 'test_*.py'
bash scripts/kubeconform.sh argocd/applications/paperless argocd/applicationsets/platform.yaml
kubectl -n argocd get application paperless
kubectl -n paperless get pods,pvc,cluster,scheduledbackup,ingress,externalsecret
```

After rollout, check Tailscale HTTPS and log in. Create a harmless synthetic
document, verify OCR, a Flamingo-backed suggestion, local embedding index,
and document chat against that document; delete the test content afterwards.
Never use confidential documents for a smoke test.

## Data durability and recovery

Each RBD claim carries `Prune=false,Delete=false`, and the runtime Secret uses
`CreatedOnce` with orphaned/retained ownership. PostgreSQL daily volume
snapshots run at **11:00 UTC** via `paperless-db-daily`. The scoped
`paperless-backup-retention` CronJob runs daily at 11:30 UTC and removes
completed backups older than 30 days, always retaining at least the two latest
successful backups. Snapshot ownership is bound to the Backup resource, so
removing it also removes its underlying Ceph volume snapshot. Snapshots live
on the same Ceph cluster and are **not offsite backups**. No automatic external
backup of the Paperless media and index is yet configured; do not treat this
deployment as a recoverable archive of irreplaceable documents until a
consistent encrypted offsite backup and restore test cover all three Paperless
PVCs, PostgreSQL, and the secrets. Export staging is ephemeral.

The current Ceph `HEALTH_WARN` has BlueStore slow operations. Keep bulk ingest
bounded until storage health is understood; no Ceph tuning or changes to
existing storage workloads are part of this application deployment.
