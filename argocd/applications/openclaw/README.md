# openclaw VM bootstrap notes

The `openclaw` VM currently consumes `cloud-init-secret.yaml` as a **SealedSecret**.
Because the secret payload is encrypted, update flow is:

1. Edit `cloud-init-userdata.yaml` (source of truth template).
2. Seal it for the cluster using `kubeseal`.
3. Replace `cloud-init-secret.yaml` with the generated SealedSecret.

## Baseline bootstrap expectations

Cloud-init should ensure:

- CLI tools installed on the VM:
  - `kubectl`
  - `argocd`
  - `kubeseal`
- OpenClaw workspace default set to:
  - `/home/ubuntu/github.com/lab/services/tuslagch`

## Re-seal command (example)

```bash
kubectl create secret generic openclaw-cloud-init \
  --namespace openclaw \
  --from-file=userdata=argocd/applications/openclaw/cloud-init-userdata.yaml \
  --dry-run=client -o yaml \
| kubeseal --format yaml --namespace openclaw --name openclaw-cloud-init \
> argocd/applications/openclaw/cloud-init-secret.yaml
```

Then commit and let ArgoCD sync the app.
