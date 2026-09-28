# Argo Workflows storage (Ceph RGW)

Argo Workflows uses a Rook `ObjectBucketClaim` backed by Ceph RGW for workflow artifacts.

## Sources of truth

1. `argocd/applications/argo-workflows/kustomization.yaml`
2. `argocd/applications/argo-workflows/objectbucketclaim.yaml`

## Required buckets

- `argo-workflows`

The `ObjectBucketClaim` provisions the bucket and a same-named secret in the `argo-workflows` namespace.

## Inspect live credentials

```bash
kubectl -n argo-workflows get objectbucketclaim argo-workflows
kubectl -n argo-workflows get secret argo-workflows
```

## Validate artifact bucket access

```bash
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ACCESS=$(kubectl -n argo-workflows get secret argo-workflows -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)
SECRET=$(kubectl -n argo-workflows get secret argo-workflows -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d)

MC_CONFIG_DIR="$tmp" mc alias set --api S3v4 argo \
  http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80 \
  "$ACCESS" \
  "$SECRET"

MC_CONFIG_DIR="$tmp" mc ls argo/argo-workflows
```
