# Registry GC Argo Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `registry` Argo CD application report `Synced/Healthy` by removing the always-suspended garbage-collection CronJob from the main app while preserving an explicit manual GC runbook.

**Architecture:** The registry serving workload stays unchanged: one `Deployment`, one `ReadWriteOnce` `rook-ceph-block` PVC, and the existing service/ingress paths. Registry garbage collection becomes documented manual maintenance because it scales the registry down and mounts the same single-writer PVC. No automatic GC schedule, replica scaling, storage migration, or live-only patch is part of this change.

**Tech Stack:** Argo CD, Kustomize/lovely, Kubernetes `Deployment`/`PVC`/`CronJob`/RBAC, Docker Registry `registry:3`, Rook Ceph RBD.

---

## File Structure

- Modify `argocd/applications/registry/kustomization.yaml` to stop applying the suspended GC CronJob and its RBAC.
- Delete `argocd/applications/registry/registry-gc-cronjob.yaml` because the suspended CronJob is the direct Argo health blocker.
- Delete `argocd/applications/registry/registry-gc-rbac.yaml` because it only exists for the removed CronJob.
- Create `docs/registry/manual-garbage-collection.md` with the exact maintenance procedure for reclaiming registry blobs when needed.

## Task 1: Confirm Baseline And Protect Serving Path

**Files:**

- Read: `argocd/applications/registry/deployment.yaml`
- Read: `argocd/applications/registry/pvc.yaml`
- Read: `argocd/applications/registry/registry-gc-cronjob.yaml`
- Read: `argocd/applications/registry/registry-gc-rbac.yaml`

- [ ] **Step 1: Confirm Argo health source**

Run:

```bash
argocd app get registry --refresh --grpc-web -o json \
  | jq '{health:.status.health, resources:[.status.resources[]? | select(.health.status == "Suspended") | {group,kind,namespace,name,health:.health.status,message:.health.message}]}'
```

Expected output shape:

```json
{
  "health": {
    "status": "Suspended"
  },
  "resources": [
    {
      "group": "batch",
      "kind": "CronJob",
      "namespace": "registry",
      "name": "registry-gc",
      "health": "Suspended",
      "message": "CronJob is suspended."
    }
  ]
}
```

- [ ] **Step 2: Confirm serving workload is healthy before changes**

Run:

```bash
kubectl --context galactic-tailscale -n registry get deploy/registry pod -o wide
kubectl --context galactic-tailscale -n registry get pvc/registry-data
kubectl --context galactic-tailscale -n registry get endpoints registry -o yaml
curl -k -fsS -m 10 https://registry.ide-newton.ts.net/v2/
```

Expected:

```text
deployment.apps/registry is 1/1 available
pod/registry-* is 1/1 Running
persistentvolumeclaim/registry-data is Bound
endpoints/registry has one ready address on port 5000
curl returns {}
```

## Task 2: Remove Suspended GC Resources From The Argo App

**Files:**

- Modify: `argocd/applications/registry/kustomization.yaml`
- Delete: `argocd/applications/registry/registry-gc-cronjob.yaml`
- Delete: `argocd/applications/registry/registry-gc-rbac.yaml`

- [ ] **Step 1: Update the registry kustomization**

Change `argocd/applications/registry/kustomization.yaml` from:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: registry
resources:
  - deployment.yaml
  - service.yaml
  - pvc.yaml
  - registry-configmap.yaml
  - registry-gc-rbac.yaml
  - registry-gc-cronjob.yaml
  - tailscale-ingress.yaml
  - ingressroute-registry-k8s-private.yaml
```

to:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: registry
resources:
  - deployment.yaml
  - service.yaml
  - pvc.yaml
  - registry-configmap.yaml
  - tailscale-ingress.yaml
  - ingressroute-registry-k8s-private.yaml
```

- [ ] **Step 2: Delete the no-longer-applied GC manifests**

Run:

```bash
git rm argocd/applications/registry/registry-gc-cronjob.yaml
git rm argocd/applications/registry/registry-gc-rbac.yaml
```

Expected:

```text
rm 'argocd/applications/registry/registry-gc-cronjob.yaml'
rm 'argocd/applications/registry/registry-gc-rbac.yaml'
```

## Task 3: Add Manual Registry GC Runbook

**Files:**

- Create: `docs/registry/manual-garbage-collection.md`

- [ ] **Step 1: Write the manual maintenance runbook**

Create `docs/registry/manual-garbage-collection.md` with:

````markdown
# Registry Manual Garbage Collection

The `registry` Argo CD app intentionally does not include a suspended garbage-collection CronJob.

The registry stores blobs on one filesystem-backed `ReadWriteOnce` PVC:

- Namespace: `registry`
- Deployment: `registry`
- PVC: `registry-data`
- StorageClass: `rook-ceph-block`
- Registry path: `/var/lib/registry`

Garbage collection is disruptive. It scales the registry deployment to zero, mounts the same PVC in a one-shot job, runs `registry garbage-collect`, then restores the deployment. Run it only during a maintenance window when there are no active image pushes.

## Preflight

```bash
kubectl --context galactic-tailscale -n registry get deploy/registry pod,pvc,endpoints -o wide
kubectl --context galactic-tailscale -n registry get events --sort-by=.lastTimestamp | tail -40
curl -k -fsS -m 10 https://registry.ide-newton.ts.net/v2/
```
````

Required state:

- `deployment.apps/registry` is `1/1`.
- `persistentvolumeclaim/registry-data` is `Bound`.
- `endpoints/registry` has exactly one ready registry pod address.
- `/v2/` returns `{}`.

## Run GC

```bash
set -euo pipefail

NS=registry
CTX=galactic-tailscale
JOB="registry-gc-manual-$(date +%Y%m%d%H%M%S)"

REGISTRY_POD="$(kubectl --context "${CTX}" -n "${NS}" get pod -l app=registry -o jsonpath='{.items[0].metadata.name}')"
REGISTRY_NODE="$(kubectl --context "${CTX}" -n "${NS}" get pod "${REGISTRY_POD}" -o jsonpath='{.spec.nodeName}')"
DESIRED_REPLICAS="$(kubectl --context "${CTX}" -n "${NS}" get deploy/registry -o jsonpath='{.spec.replicas}')"

cleanup() {
  kubectl --context "${CTX}" -n "${NS}" delete job "${JOB}" --wait=true --timeout=10m --ignore-not-found
  kubectl --context "${CTX}" -n "${NS}" scale deploy/registry --replicas="${DESIRED_REPLICAS:-1}"
  kubectl --context "${CTX}" -n "${NS}" rollout status deploy/registry --timeout=10m
}
trap cleanup EXIT

kubectl --context "${CTX}" -n "${NS}" scale deploy/registry --replicas=0
kubectl --context "${CTX}" -n "${NS}" rollout status deploy/registry --timeout=5m || true
kubectl --context "${CTX}" -n "${NS}" wait --for=delete pod -l app=registry --timeout=5m

cat <<YAML | kubectl --context "${CTX}" -n "${NS}" apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB}
spec:
  activeDeadlineSeconds: 7200
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      nodeName: ${REGISTRY_NODE}
      restartPolicy: Never
      containers:
        - name: gc
          image: registry:3
          command:
            - /bin/registry
            - garbage-collect
            - /etc/docker/registry/config.yml
          volumeMounts:
            - name: registry-data
              mountPath: /var/lib/registry
            - name: registry-config
              mountPath: /etc/docker/registry
      volumes:
        - name: registry-data
          persistentVolumeClaim:
            claimName: registry-data
        - name: registry-config
          configMap:
            name: registry-config
YAML

kubectl --context "${CTX}" -n "${NS}" wait --for=condition=complete "job/${JOB}" --timeout=2h
kubectl --context "${CTX}" -n "${NS}" logs "job/${JOB}"
```

## Postflight

```bash
kubectl --context galactic-tailscale -n registry rollout status deploy/registry --timeout=10m
kubectl --context galactic-tailscale -n registry get deploy/registry pod,pvc,endpoints -o wide
curl -k -fsS -m 10 https://registry.ide-newton.ts.net/v2/
argocd app get registry --refresh --grpc-web
```

Required state:

- Registry deployment is `1/1`.
- Registry pod is `Running`.
- Registry endpoint has a ready address.
- `/v2/` returns `{}`.
- Argo app remains `Synced/Healthy`.

````

## Task 4: Validate Render And GitOps Diff Locally

**Files:**
- Validate: `argocd/applications/registry`
- Validate: `docs/registry/manual-garbage-collection.md`

- [ ] **Step 1: Render the registry application**

Run:

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/registry > /tmp/registry-render.yaml
````

Expected:

```text
command exits 0
```

- [ ] **Step 2: Prove the removed GC resources are absent**

Run:

```bash
yq e 'select(.kind == "CronJob" and .metadata.name == "registry-gc") | .metadata.name' /tmp/registry-render.yaml
yq e 'select((.kind == "Role" or .kind == "RoleBinding" or .kind == "ServiceAccount") and .metadata.name == "registry-gc") | .kind + "/" + .metadata.name' /tmp/registry-render.yaml
```

Expected:

```text
both commands print no matching resources
```

- [ ] **Step 3: Prove serving resources still render**

Run:

```bash
yq e 'select(.kind == "Deployment" and .metadata.name == "registry") | .spec.replicas' /tmp/registry-render.yaml
yq e 'select(.kind == "PersistentVolumeClaim" and .metadata.name == "registry-data") | .spec.storageClassName' /tmp/registry-render.yaml
yq e 'select(.kind == "Service" and .metadata.name == "registry") | .spec.ports[0].targetPort' /tmp/registry-render.yaml
```

Expected:

```text
1
rook-ceph-block
5000
```

- [ ] **Step 4: Run Argo lint**

Run:

```bash
bun run lint:argocd
```

Expected:

```text
command exits 0
```

## Task 5: PR, Merge, And Rollout Validation

**Files:**

- Commit: `argocd/applications/registry/kustomization.yaml`
- Commit deletion: `argocd/applications/registry/registry-gc-cronjob.yaml`
- Commit deletion: `argocd/applications/registry/registry-gc-rbac.yaml`
- Commit: `docs/registry/manual-garbage-collection.md`

- [ ] **Step 1: Commit the change**

Run:

```bash
git status --short
git add argocd/applications/registry/kustomization.yaml docs/registry/manual-garbage-collection.md
git add -u argocd/applications/registry/registry-gc-cronjob.yaml argocd/applications/registry/registry-gc-rbac.yaml
git commit -m "fix(registry): remove suspended gc cronjob from app"
```

Expected:

```text
commit succeeds with only registry GitOps and registry docs changes
```

- [ ] **Step 2: Create the PR using the repo template**

Run:

```bash
cp .github/PULL_REQUEST_TEMPLATE.md /tmp/registry-gc-pr.md
```

Fill `/tmp/registry-gc-pr.md` with:

```markdown
## Summary

- remove the suspended `registry-gc` CronJob and its RBAC from the registry Argo app
- add a manual registry garbage-collection runbook for maintenance windows
- keep the serving registry deployment, PVC, service, and ingress unchanged

## Testing

- `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/registry > /tmp/registry-render.yaml`
- `bun run lint:argocd`
- verified rendered registry app no longer includes `CronJob/registry-gc`
- verified rendered deployment/PVC/service still match the existing serving path

## Rollout

- merge through normal GitOps
- refresh and sync Argo app `registry`
- verify final state is `Synced/Healthy`
- verify `https://registry.ide-newton.ts.net/v2/` returns `{}`

## Risk

The deleted CronJob was suspended and not running. Registry serving resources are unchanged. Manual GC remains documented and should only run during a maintenance window because it scales the registry down and mounts the single RWO PVC.
```

Then run:

```bash
rg -n "TODO|TBD|<|>|\\[ \\]" /tmp/registry-gc-pr.md
gh pr create --title "fix(registry): remove suspended gc cronjob from app" --body-file /tmp/registry-gc-pr.md
```

Expected:

```text
placeholder scan prints no unresolved template placeholders
gh pr create returns a PR URL
```

- [ ] **Step 3: Wait for CI and merge**

Run:

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
gh pr checks "${PR_NUMBER}" --watch -R proompteng/lab
gh pr merge "${PR_NUMBER}" --squash -R proompteng/lab
```

Expected:

```text
checks are green before merge
PR merges through squash merge
```

- [ ] **Step 4: Sync and validate Argo**

Run:

```bash
argocd app get registry --refresh --grpc-web
argocd app sync registry --grpc-web
kubectl --context galactic-tailscale -n registry rollout status deploy/registry --timeout=10m
kubectl --context galactic-tailscale -n registry get deploy/registry pod,pvc,endpoints -o wide
curl -k -fsS -m 10 https://registry.ide-newton.ts.net/v2/
argocd app get registry --refresh --grpc-web -o json | jq '{sync:.status.sync.status, health:.status.health.status, resources:[.status.resources[]? | select(.health.status == "Suspended") | {kind,name,health:.health.status,message:.health.message}]}'
```

Expected:

```json
{
  "sync": "Synced",
  "health": "Healthy",
  "resources": []
}
```

## Rollback

- If registry serving breaks after rollout, revert the PR and sync `registry`.
- Do not scale registry above one replica as a rollback; the PVC is still `ReadWriteOnce`.
- If manual GC is urgently needed before the new runbook is merged, use the existing suspended CronJob manifest from Git history as a one-shot reference, run it during a maintenance window, and delete the job afterward.

## Acceptance Criteria

- `argocd app get registry --refresh --grpc-web` reports `Synced/Healthy`.
- `registry` namespace has no `CronJob/registry-gc`, `Role/registry-gc`, `RoleBinding/registry-gc`, or `ServiceAccount/registry-gc`.
- `Deployment/registry` remains `1/1`.
- `PVC/registry-data` remains `Bound`.
- `https://registry.ide-newton.ts.net/v2/` returns `{}`.
- Manual GC procedure is documented and explicitly marked disruptive.
