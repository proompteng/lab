# CMS

## Database

`postgres-cluster.yaml` provisions the `cms-db` CNPG cluster (5Gi volume). CNPG emits the application secret
`cms-db-app` (key `uri`) which the deployment uses for `DATABASE_URL` and is reflected into `pgadmin`.

## Secrets

Create a `cms-env` secret in the `cms` namespace with just the Payload secret:

```bash
kubectl -n cms create secret generic cms-env \
  --from-literal=PAYLOAD_SECRET='...'
```

## Notes

- `PAYLOAD_PUBLIC_SERVER_URL` and `LANDING_SITE_URL` are configured in the deployment manifest.
- Update `argocd/applications/cms/kustomization.yaml` if you want to pin a specific image tag.
