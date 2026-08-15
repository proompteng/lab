# Restate GitOps rollout notes

This application deploys the self-hosted Restate server and its private admin UI exposure.

## Operator and request-identity foundation rollout

This rollout installs the Restate Operator foundation but does not register, activate, or move any Bayn execution.
The root ApplicationSet creates two independently reconciled automated applications: `restate-operator-crds` and
`restate-operator`, whose chart is configured with `installCrds: false`. The operational order is CRDs first, operator
second: the CRD application must report `Synced` and `Healthy` before any `RestateDeployment` is committed. If the
operator application reconciles while its CRDs are still settling, hold the Bayn worker layer and verify that both
applications converge; do not create resources by hand.

The same GitOps revision mounts the sealed request-identity private key into the existing single-replica Restate
StatefulSet. That change replaces the Restate pod and can briefly make the control plane unavailable. Existing Bayn
execution remains on its legacy fail-closed owner during this foundation rollout, so this restart must not create a
second lifecycle writer or broker mutation path. The PVC, Restate metadata, and existing deployment registrations are
preserved.

After Argo reconciles `main`, verify the ordered foundation without printing the private key:

```sh
kubectl get application -n argocd restate-operator-crds restate-operator restate -o wide
kubectl get crd -n restate-operator restatedeployments.restate.dev -o name
kubectl rollout status deployment/restate-operator -n restate-operator --timeout=180s
kubectl rollout status statefulset/restate -n restate --timeout=300s
kubectl exec -n restate statefulset/restate -- test -s /var/run/secrets/restate/request-identity/private.pem
kubectl get restatedeployment -n bayn
```

Expected:

- both operator applications and `restate` are `Synced` and `Healthy`;
- the operator deployment and Restate StatefulSet complete rollout;
- the request-identity file exists and is non-empty without its contents entering logs;
- no Bayn `RestateDeployment` exists at this foundation layer;
- the existing Restate admin and ingress Services retain ready endpoints.

The same revision extends the auto-synced observability application with Restate server and operator scrapes. Its
configuration hash change replaces the single `observability-cluster-metrics-alloy` pod. A short scrape gap and a new
pod identity are expected; loss of the pre-existing Bayn, CNPG, Ceph, kubelet, or kube-state-metrics targets is not.
The two new unavailable alerts may remain pending for at most their two-minute evaluation window while Restate and the
operator converge.

Verify the collector rollout and both new targets without changing cluster state:

```sh
kubectl rollout status deployment/observability-cluster-metrics-alloy -n observability --timeout=180s
kubectl get pods -n observability -l app.kubernetes.io/name=observability-cluster-metrics-alloy -o wide
kubectl logs -n observability deployment/observability-cluster-metrics-alloy --since=10m | grep -E 'restate|error'
```

In Mimir or Grafana, require `up{job="restate-server"} == 1` and `up{job="restate-operator"} == 1`, then confirm the
pre-existing `bayn`, `cnpg-postgres`, `ceph-storage`, `kubelet`, `kubelet-cadvisor`, and `kube-state-metrics` jobs still
report `up == 1`. If the Alloy rollout fails or an existing target disappears, revert this foundation commit through a
normal PR. Argo will restore the prior Alloy configuration hash and alert rules; wait for the replacement collector to
become available and recheck every pre-existing target before resuming the worker layer.

If the operator or signing-key rollout does not converge, revert this foundation commit through a normal PR and let
Argo reconcile the prior StatefulSet. Before removing operator CRDs, prove that no `RestateDeployment` objects exist;
remove the operator application before its CRD application, and never manually delete a CRD that still has instances.
The rollback must leave the Restate PVC and prior service registrations intact. Recheck the StatefulSet, Services, and
admin API after the revert before resuming the Bayn worker layer.

## Admin UI exposure

`restate-admin-tailscale` exposes the Restate admin/UI port only through the Tailscale Kubernetes operator:

- Tailscale hostname: `restate`
- Kubernetes Service: `restate-admin-tailscale`
- External port: `80`
- Restate target port: `admin` / `9070`

The Service intentionally carries `argocd.argoproj.io/ignore-healthcheck: "true"` because the Tailscale operator owns LoadBalancer readiness and the Argo health check should not block on tailnet endpoint allocation.

## Post-sync verification

After Argo reconciles this app from `main`, verify the core application and generated Tailscale resources:

```sh
kubectl get application -n argocd restate -o wide
kubectl get svc -n restate restate restate-admin-tailscale -o wide
kubectl get pods -n tailscale -l tailscale.com/parent-resource-ns=restate,tailscale.com/parent-resource=restate-admin-tailscale -o wide
```

Expected:

- the `restate` Argo Application is `Synced` and `Healthy`;
- `restate-admin-tailscale` exists with `loadBalancerClass: tailscale`;
- one Tailscale proxy pod exists in the `tailscale` namespace with parent labels for `restate-admin-tailscale`;
- opening `http://restate` from an authorized tailnet client reaches the Restate admin UI.

Verify the NetworkPolicy still blocks ordinary cluster workloads from admin port `9070`:

```sh
kubectl run restate-admin-deny-check \
  -n default \
  --rm \
  -i \
  --restart=Never \
  --image=curlimages/curl:8.17.0 \
  --image-pull-policy=IfNotPresent \
  --command -- sh -ec '
    if curl -sS --connect-timeout 2 --max-time 5 http://restate.restate.svc.cluster.local:9070/services >/tmp/out 2>/tmp/err; then
      echo unexpected_admin_access
      cat /tmp/out
      exit 1
    fi
    echo admin_access_blocked
    cat /tmp/err
  '
```

Expected result: `admin_access_blocked`.

## Recovery

If `http://restate` is unreachable after Argo sync:

1. Inspect the Service and Tailscale proxy pod:
   ```sh
   kubectl describe svc -n restate restate-admin-tailscale
   kubectl get pods -n tailscale -l tailscale.com/parent-resource-ns=restate,tailscale.com/parent-resource=restate-admin-tailscale -o wide
   kubectl logs -n tailscale -l tailscale.com/parent-resource-ns=restate,tailscale.com/parent-resource=restate-admin-tailscale --tail=200
   ```
2. Verify Restate itself is healthy inside the cluster:
   ```sh
   kubectl -n restate port-forward svc/restate 9070:9070
   curl -sSf http://127.0.0.1:9070/services
   ```
3. Confirm the NetworkPolicy has the Tailscale parent-resource allow rule for `restate-admin-tailscale`.
4. If the Tailscale endpoint must be removed, revert the commit that added `admin-tailscale-service.yaml` and the matching NetworkPolicy rule, merge through GitOps, and sync the root Argo application.

Do not expose Restate admin port `9070` through a public Ingress or unrestricted LoadBalancer. The admin port allows state-changing deployment registration.
