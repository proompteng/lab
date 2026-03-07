# openclaw VM bootstrap notes

The `openclaw` VM consumes `cloud-init-secret.yaml` as a **SealedSecret**.

> This repo intentionally does **not** store plaintext cloud-init userdata.

Because the payload is encrypted, update flow is:

1. Prepare a local `cloud-init-userdata.yaml` file (temporary, do not commit).
2. Seal it with `kubeseal`.
3. Overwrite `argocd/applications/openclaw/cloud-init-secret.yaml` with the sealed output.

## Baseline bootstrap expectations

Cloud-init should ensure:

- CLI tools installed on the VM:
  - `kubectl`
  - `argocd`
  - `kubeseal`
- OpenClaw workspace default set to:
  - `/home/ubuntu/github.com/lab/services/tuslagch`
- in-VM Kubernetes access is bootstrapped by mounting the `serviceAccount` disk
  (`K8S_SA_DISK`) and writing `/home/ubuntu/.kube/config`.

## VM access model

- ServiceAccount: `openclaw-vm` (namespace `openclaw`)
- RBAC scope:
  - can `create/delete/get/list/patch/update/watch` Argo CD `applications` in namespace `argocd`
  - can `create/delete/get/list/watch` `agents.proompteng.ai/AgentRun` in namespace `agents`

## Re-seal command (example)

Run from repo root (`~/github.com/lab`):

```bash
kubectl create secret generic openclaw-cloud-init \
  --namespace openclaw \
  --from-file=userdata=./cloud-init-userdata.yaml \
  --dry-run=client -o yaml \
| kubeseal --format yaml --namespace openclaw --name openclaw-cloud-init \
> argocd/applications/openclaw/cloud-init-secret.yaml
```

Then commit and let ArgoCD sync the app.
