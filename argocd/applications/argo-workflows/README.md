# Argo Workflows storage (Ceph RGW)

Argo Workflows uses Ceph RGW object storage for workflow artifacts.

## Sources of truth

1. `argocd/applications/argo-workflows/kustomization.yaml`
2. `argocd/applications/argo-workflows/rook-ceph-objectstore-user.yaml`
3. `argocd/applications/argo-workflows/rook-ceph-rgw-argo-workflows.yaml`
4. `argocd/applications/argo-workflows/rgw-bucket-job.yaml`

## Required buckets

- `argo-workflows`

The `argocd/applications/argo-workflows/rgw-bucket-job.yaml` hook ensures the bucket exists.

## Rotate RGW credentials

1. Ensure the `CephObjectStoreUser` exists and is `Ready`:

```bash
kubectl -n rook-ceph get cephobjectstoreuser argo-workflows
kubectl -n rook-ceph get secret rook-ceph-object-user-objectstore-argo-workflows
```

2. Generate a sealed secret for Argo Workflows using the active Sealed Secrets controller:

```bash
kubectl -n rook-ceph get secret rook-ceph-object-user-objectstore-argo-workflows -o json \
  | jq 'del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.annotations,.metadata.labels) \
        | .metadata.name="rook-ceph-rgw-argo-workflows" \
        | .metadata.namespace="argo-workflows" \
        | .type="Opaque" \
        | .data={"accessKey": .data.AccessKey, "secretKey": .data.SecretKey}' \
  | kubectl apply -f -

./scripts/reseal-secret-from-cluster.sh \
  argo-workflows \
  rook-ceph-rgw-argo-workflows \
  argocd/applications/argo-workflows/rook-ceph-rgw-argo-workflows.yaml

kubectl -n argo-workflows delete secret rook-ceph-rgw-argo-workflows
```

3. Commit and sync `argo-workflows`.
