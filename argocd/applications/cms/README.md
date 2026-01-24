# CMS

## Secrets

Create a `cms-env` secret in the `cms` namespace with these keys:

- `DATABASE_URL`
- `PAYLOAD_SECRET`

Example (apply via your preferred secret management flow):

```bash
kubectl -n cms create secret generic cms-env \
  --from-literal=DATABASE_URL='postgres://...' \
  --from-literal=PAYLOAD_SECRET='...'
```

## Notes

- `PAYLOAD_PUBLIC_SERVER_URL` and `LANDING_SITE_URL` are configured in the deployment manifest.
- Update `argocd/applications/cms/kustomization.yaml` if you want to pin a specific image tag.
