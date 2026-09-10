# CMS

## Database

`postgres-cluster.yaml` provisions the `cms-db` CNPG cluster (5Gi volume). CNPG emits the application secret
`cms-db-app` (key `uri`) which the deployment uses for `DATABASE_URL` and is reflected into `pgadmin`.

## Secrets

`secret.yaml` contains the `cms-env` SealedSecret with `PAYLOAD_SECRET`.
To rotate it, run:

```bash
./scripts/seal-generic-secret.sh cms cms-env argocd/applications/cms/secret.yaml PAYLOAD_SECRET='<new-secret>'
```

## Notes

- `PAYLOAD_PUBLIC_SERVER_URL` and `LANDING_SITE_URL` are configured in the deployment manifest.
- Update `argocd/applications/cms/kustomization.yaml` if you want to pin a specific image tag.
