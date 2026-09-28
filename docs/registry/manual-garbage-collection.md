# Registry Manual Garbage Collection

The `registry` Argo CD app intentionally does not include a suspended garbage-collection CronJob.

The registry stores blobs on one filesystem-backed `ReadWriteOnce` PVC:

- Namespace: `registry`
- Deployment: `registry`
- PVC: `registry-data`
- StorageClass: `rook-ceph-block`
- Registry path: `/var/lib/registry`

Garbage collection is disruptive. It scales the registry deployment to zero, mounts the same PVC in a
one-shot job, runs `registry garbage-collect`, then restores the deployment. Run it only during a
maintenance window when there are no active image pushes.

## Preflight

```bash
kubectl --context galactic-tailscale -n registry get deploy/registry -o wide
kubectl --context galactic-tailscale -n registry get pod,pvc,endpoints -o wide
kubectl --context galactic-tailscale -n registry get events --sort-by=.lastTimestamp | tail -40
curl -k -fsS -m 10 https://registry.ide-newton.ts.net/v2/
```

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
kubectl --context galactic-tailscale -n registry get deploy/registry -o wide
kubectl --context galactic-tailscale -n registry get pod,pvc,endpoints -o wide
curl -k -fsS -m 10 https://registry.ide-newton.ts.net/v2/
argocd app get registry --refresh --grpc-web
```

Required state:

- Registry deployment is `1/1`.
- Registry pod is `Running`.
- Registry endpoint has a ready address.
- `/v2/` returns `{}`.
- Argo app remains `Synced/Healthy`.
