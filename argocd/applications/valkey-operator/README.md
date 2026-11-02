# Valkey operator

Installs the Apache-2.0 licensed **chideat/valkey-operator**, independently of the
existing Redis operator. It does not migrate applications or create a shared
Valkey database.

The platform ApplicationSet owns the `valkey-operator` Application and the
`valkey-system` namespace. The upstream v2.1.0 Kustomize source is pinned to its
commit and the multi-architecture operator image is pinned by digest. The helper
image used for managed instances uses the same release tag. `operatorVersion`
must remain a semantic version because it also selects reconciliation actors;
it cannot contain an image digest. Per-instance helper digest overrides use the
upstream `buf.red/imageversions-valkey-helper` annotation instead. The overlay
prefixes upstream resource names to avoid collisions with other operators.

Two leader-electing controller replicas run with restricted pod security and
preferred node anti-affinity. Admission webhooks remain enabled, with certificates
managed by the existing cert-manager installation. Namespace and CRD retention
prevent accidental data deletion when removing the Application.

## Validation

```bash
kustomize build argocd/applications/valkey-operator > /tmp/valkey-operator.yaml
bash scripts/kubeconform.sh /tmp/valkey-operator.yaml
kubectl -n argocd get application valkey-operator
kubectl -n valkey-system rollout status deployment/chideat-valkey-operator
kubectl -n valkey-system get certificates,deployments,pods
kubectl get crd valkeys.rds.valkey.buf.red clusters.valkey.buf.red \
  failovers.valkey.buf.red sentinels.valkey.buf.red users.valkey.buf.red
```

Before assigning application traffic, validate admission, managed instance
creation, authenticated write/read, and recovery using a disposable Valkey
instance. Upstream v2.1.0 reports testing Kubernetes 1.33–1.35; other versions
require live compatibility validation rather than assuming upstream coverage.

## Upgrade and recovery

Update the source commit, controller image digest, and helper image annotation
together in a reviewed PR. Render the overlay and inspect CRD changes before
merging. Let Argo CD reconcile the reviewed source; do not install a second Helm
release over these resources.

To roll back an operator upgrade, revert the relevant GitOps change after checking
CRD/API compatibility. Never delete CRDs or the namespace as a rollback method:
they can contain independently managed Valkey instances and their data. This
deployment does not change the existing Redis operator or its workloads.
