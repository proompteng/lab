# Restate GitOps rollout notes

This application deploys the self-hosted Restate server and its private admin UI exposure.

## Admin UI exposure

`restate-admin-tailscale` exposes the Restate admin/UI port only through the Tailscale Kubernetes operator:

- Tailscale hostname: `restate-admin`
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
- opening `http://restate-admin` from an authorized tailnet client reaches the Restate admin UI.

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

If `http://restate-admin` is unreachable after Argo sync:

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
