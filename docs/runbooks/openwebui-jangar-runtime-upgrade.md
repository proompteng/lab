# Open WebUI and Jangar runtime upgrade

The release selects Open WebUI 0.11.3 with Helm chart 16.5.0 and Docker Engine
29.8.0 for Jangar. Jangar's existing Docker client remains compatible; the daemon
keeps classic overlay2 because the application consumes its shared graph directory.
Docker is a native Kubernetes sidecar: its startup probe gates the app, and it
remains available while the app shuts down. The existing bootstrap init container
and the app remain at the indices consumed by Kargo. The workspace PVC, database
credentials, auth settings, backend destinations and service addresses are preserved.

## Delivery and acceptance

1. Back up the Open WebUI PostgreSQL public schema and its vector database/files.
   Use a consistent native SQLite backup for `vector_db/chroma.sqlite3` and require
   stable index-file hashes during the copy. Model download caches are reproducible;
   keep the original PVC rather than copying or replacing its cache.
2. Restore the logical backup into a network-isolated PostgreSQL 17.11 instance.
   Run the exact 0.11.3 image's Alembic upgrade. Check every original row, account
   identity, chat timer and all six new indexes. Chroma remains at 1.5.9 in both
   images; verify its restored SQLite integrity and collections.
3. Verify the Docker client against Engine 29.8.0 with classic overlay2 and a real
   isolated container invocation. Check that Jangar has no active Docker containers
   before the release rolls out.
4. Merge only after exact-head CI and review pass. The normal Jangar build,
   Warehouse, automatic Stage promotion and Kargo branch deliver both changes.
   Do not manually pin the Jangar image or sync its image release.
5. Confirm the deployed revision and image digests, original PVC/Secret identities,
   Open WebUI migration head `d4c1a8e37b62`, existing users and chats, vector records,
   private browser chat completion, and the live Docker client/container operation.

## Impact and recovery

Jangar and the singleton Open WebUI instance restart during normal reconciliation.
The PostgreSQL migrations add a nullable chat timer column and indexes, and repair
only double-encoded OAuth objects. Preserve credential identities and existing
settings. Keep the fresh logical/file backups alongside the existing CNPG continuous
backup and WAL archive until live acceptance is complete.

If activation fails, stop the next upgrade and inspect the first migration or
startup error. Revert the reviewed image/chart change through GitOps after checking
schema compatibility. Do not force-delete Pods or storage, overwrite the Jangar
workspace, reset credentials, or run old database engines on upgraded data. Docker's
graph is the existing emptyDir; no persistent graph format migration is introduced.

Sources: [Open WebUI 0.11.3](https://github.com/open-webui/open-webui/releases/tag/v0.11.3),
[Open WebUI migrations](https://github.com/open-webui/open-webui/tree/v0.11.3/backend/open_webui/migrations/versions),
[Kubernetes sidecars](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/).
