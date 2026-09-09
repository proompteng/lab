# Cert-Manager

## Known Issues

### Cainjector Leader Election

**Issue:** Cainjector tries to use kube-system for leader election by default, causing permission errors when deployed in cert-manager namespace.

**Reference:** [cert-manager/cert-manager#6716](https://github.com/cert-manager/cert-manager/issues/6716)

**Fix:** Set leader election namespace in Helm values:

```yaml
global:
  leaderElection:
    namespace: cert-manager

### Startup API Check Hook Duplication

**Issue:** ArgoCD sync loops can happen when the cert-manager `startupapicheck` Helm hook attempts to re-create RBAC resources that already exist with Argo hook finalizers.

**Fix:** Disable the startup API check hook in this environment:

```yaml
startupapicheck:
  enabled: false
```
```
