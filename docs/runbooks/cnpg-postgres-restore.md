# CNPG Postgres Restore Runbook (`jangar-db`)

Last updated: 2026-02-24

## Scope

This runbook restores the CloudNativePG cluster `jangar-db` in namespace `jangar` from object-store backups.

It covers:

1. Non-destructive restore to a temporary cluster for validation.
2. Production cutover/replace flow after validation.
3. Latest-backup and point-in-time restore options.

## Current Backup Configuration (Source of Truth)

From GitOps manifests:

- Cluster: `argocd/applications/jangar/postgres-cluster.yaml`
- Scheduled backup: `argocd/applications/jangar/postgres-scheduled-backup.yaml`

Current values:

- Cluster: `jangar-db`
- Backup method: `barmanObjectStore`
- Object store: `s3://cnpg/jangar-db`
- Endpoint: `http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80`
- Credentials secret: `cnpg-jangar-db` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Retention: `14d`
- Scheduled backup CRON: `0 0 11 * * *` (CNPG cron includes seconds)

Reference: `0 0 11 * * *` is 11:00 UTC daily (3:00 AM PST / 4:00 AM PDT).
Always confirm the controller's effective schedule from `status.nextScheduleTime` on the `ScheduledBackup` object.

## Preconditions

1. `kubectl` access to the cluster.
2. `kubectl cnpg` plugin installed (recommended).
3. Confirm backups exist and are healthy:

```bash
kubectl -n jangar get cluster.postgresql.cnpg.io jangar-db -o wide
kubectl -n jangar get scheduledbackup.postgresql.cnpg.io jangar-db-daily -o wide
kubectl -n jangar get backup.postgresql.cnpg.io -o wide
```

4. If the source cluster is still writable, plan a short write freeze before final cutover to avoid divergence.

## Step 1: Pick Recovery Mode

Choose one:

1. Latest state from archive + latest base backup:
- Use `bootstrap.recovery.source` only.

2. Specific backup object:
- Add `bootstrap.recovery.backup.name: <backup-cr-name>`.

3. Point-in-time recovery (PITR):
- Add `bootstrap.recovery.recoveryTarget.targetTime: "<RFC3339-or-Postgres-time>"`.
- Optionally include `backup.name` to force the base backup used for PITR.

## Step 2: (Optional) Take a Fresh Manual Backup

If `jangar-db` is healthy before maintenance, trigger a manual backup:

```bash
kubectl cnpg backup -n jangar jangar-db --method barmanObjectStore --backup-name jangar-db-manual-$(date -u +%Y%m%d%H%M%S)
```

Wait until it completes:

```bash
kubectl -n jangar get backup.postgresql.cnpg.io -w
```

## Step 3: Restore to a Temporary Cluster (Recommended)

Create a restore manifest (example: latest backup):

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: jangar-db-restore
  namespace: jangar
spec:
  instances: 1
  storage:
    storageClass: rook-ceph-block
    size: 50Gi
  bootstrap:
    recovery:
      source: jangar-db-backups
      # Optional: restore from a specific backup object
      # backup:
      #   name: jangar-db-daily-20260224000000
      # Optional: point in time recovery
      # recoveryTarget:
      #   targetTime: '2026-02-24T05:35:00Z'
  externalClusters:
    - name: jangar-db-backups
      barmanObjectStore:
        destinationPath: s3://cnpg/jangar-db
        endpointURL: http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80
        serverName: jangar-db
        s3Credentials:
          accessKeyId:
            name: cnpg-jangar-db
            key: AWS_ACCESS_KEY_ID
          secretAccessKey:
            name: cnpg-jangar-db
            key: AWS_SECRET_ACCESS_KEY
```

Apply and wait:

```bash
kubectl apply -f /tmp/jangar-db-restore.yaml
kubectl -n jangar get cluster.postgresql.cnpg.io jangar-db-restore -w
kubectl cnpg status -n jangar jangar-db-restore
```

Important:

- Do not configure this temporary cluster to archive WAL back to the same source path using the same `serverName` while `jangar-db` is still active.
- Temporary cluster generated secrets are `jangar-db-restore-app` and `jangar-db-restore-ca`.

## Step 4: Validate the Restored Data

Basic checks:

```bash
kubectl cnpg psql -n jangar jangar-db-restore -- -d jangar -c "select now(), pg_is_in_recovery();"
kubectl cnpg psql -n jangar jangar-db-restore -- -d jangar -c "select count(*) from information_schema.tables where table_schema='public';"
```

Application-specific checks (example):

```bash
kubectl cnpg psql -n jangar jangar-db-restore -- -d jangar -c "select count(*) from atlas.github_events;"
kubectl cnpg psql -n jangar jangar-db-restore -- -d jangar -c "select max(received_at) from atlas.github_events;"
```

## Step 5: Production Cutover Options

### Option A: Keep Restore Cluster as DR Validation Only

- Leave `jangar-db` untouched.
- Delete temporary restore cluster after validation.

### Option B: Replace Production Cluster (Downtime Required)

1. Freeze writers (scale app deployments down):

```bash
kubectl -n jangar scale deploy/jangar deploy/bumba --replicas=0
```

2. Confirm no active writes (optional SQL checks).

3. Delete old cluster (PVC cleanup if needed by your reclaim policy):

```bash
kubectl -n jangar delete cluster.postgresql.cnpg.io jangar-db
```

4. Apply a recovery manifest with `metadata.name: jangar-db` (same as production name), using:
- `bootstrap.recovery.source`
- `externalClusters[].barmanObjectStore` pointing to `s3://cnpg/jangar-db`
- `serverName: jangar-db`

5. Wait for `Ready=True` and validate SQL checks.

6. Scale applications back up:

```bash
kubectl -n jangar scale deploy/jangar deploy/bumba --replicas=1
kubectl -n jangar rollout status deploy/jangar
kubectl -n jangar rollout status deploy/bumba
```

7. Verify new backups continue to run:

```bash
kubectl -n jangar get backup.postgresql.cnpg.io -o wide
kubectl -n jangar get scheduledbackup.postgresql.cnpg.io jangar-db-daily -o yaml | rg -n "nextScheduleTime|lastScheduleTime"
```

## Step 6: Cleanup Temporary Restore Cluster

If you used `jangar-db-restore` only for validation:

```bash
kubectl -n jangar delete cluster.postgresql.cnpg.io jangar-db-restore
```

## Fast Troubleshooting

1. Restore cluster stuck before ready:
- `kubectl -n jangar describe cluster.postgresql.cnpg.io jangar-db-restore`
- `kubectl -n cnpg-system logs deploy/cnpg-controller-manager --since=30m`

2. Missing backup objects in Kubernetes but data exists in object store:
- Use `externalClusters` + `recoveryTarget` and restore from object store history.

3. Access denied to object store:
- Verify `cnpg-jangar-db` secret keys:

```bash
kubectl -n jangar get secret cnpg-jangar-db -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | wc -c
kubectl -n jangar get secret cnpg-jangar-db -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | wc -c
```

## Notes

- Prefer GitOps for planned recovery: commit restore manifests under `argocd/applications/jangar` and sync with Argo CD.
- For incident response, direct `kubectl apply` is acceptable, then backport the manifest change to Git.
