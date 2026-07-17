# Troubleshooting: Talos-owned Flannel VXLAN

Talos owns the complete Flannel manifest through `cluster.network.cni.name: custom`. The manifest URL is pinned to an
immutable Git commit by `devices/galactic/manifests/custom-flannel-cni.patch.yaml`; the bundle owns the ClusterRole,
ClusterRoleBinding, ServiceAccount, ConfigMap, and DaemonSet together. Argo CD does not manage any Flannel resource.

The custom bundle is required because stable Talos 1.13 does not expose a native Flannel MTU setting. Fresh ARC runners
at pod MTU 1450 repeatedly timed out fetching GitHub pipeline connection data; changing the same pod to MTU 1400 made
it register and claim work immediately. Do not reduce the physical underlay MTU to force Flannel's derived value:
adding an otherwise-incomplete interface entry can displace platform-provided addressing and remove a control-plane
node from the network.

Before changing the CNI source or upgrading Kubernetes, confirm the pinned manifest is reachable and valid:

```bash
curl -fsS "$(yq -r '.cluster.network.cni.urls[0]' devices/galactic/manifests/custom-flannel-cni.patch.yaml)" \
  | kubeconform -strict -summary -
```

## Ownership cutover

Do not start the cutover unless all control-plane nodes are reachable, etcd has a leader and quorum, and the Kubernetes
API is ready. Apply the checked-in patch to one control-plane node at a time without rebooting:

```bash
talosctl -e <healthy-control-plane-ip> -n <node-ip> patch machineconfig --mode=no-reboot \
  --patch @devices/galactic/manifests/custom-flannel-cni.patch.yaml
```

After every node is patched, verify its safe CNI subtree and the Talos manifest inventory:

```bash
talosctl -e <healthy-control-plane-ip> -n <node-ip> get machineconfig v1alpha1 -o yaml \
  | yq -r '.spec' | yq -e '.cluster.network.cni.name == "custom" and (.cluster.network.cni.urls | length == 1)'
talosctl -e <healthy-control-plane-ip> -n <node-ip> get manifests
talosctl -e <healthy-control-plane-ip> -n <node-ip> get manifeststatuses
```

Keep the Argo application in place until Talos has downloaded and applied the custom manifest and the network checks
below pass. After Git removes the application, confirm `Application/flannel-cni` is absent, then remove its stale
preservation annotation from the now Talos-owned ConfigMap:

```bash
kubectl -n argocd get application flannel-cni
kubectl -n kube-system annotate configmap kube-flannel-cfg argocd.argoproj.io/sync-options-
```

Before the Argo application is removed, rollback is a machine-config patch back to `name: flannel` with an empty URL
list; the Argo MTU guard remains the safety net. After Argo removal, restore the guard in Git before making that rollback
so MTU 1400 is never left without an owner.

Before every Kubernetes upgrade, inspect the Talos manifest plan:

```bash
talosctl -e <control-plane-ip> -n <control-plane-ip> upgrade-k8s --to <target-version> --dry-run
```

The dry run must retain the custom CNI URL and keep the VXLAN backend on UDP 4789. Immediately after the upgrade,
verify the Talos-owned ConfigMap, restart the Flannel DaemonSet, and validate a newly-created pod on every node:

```bash
kubectl -n kube-system get configmap kube-flannel-cfg \
  -o jsonpath='{.data.cni-conf\.json}' | jq -e '.plugins[0].delegate.mtu == 1400'
kubectl -n kube-system rollout restart daemonset/kube-flannel
kubectl -n kube-system rollout status daemonset/kube-flannel --timeout=180s
kubectl -n <workload-namespace> exec <fresh-pod-on-each-node> -- \
  sh -c "ip -o link show eth0 | grep -q 'mtu 1400'"
```

The custom CNI delegate does not change Flannel's backend MTU, and `/run/flannel/subnet.env` may still report
`FLANNEL_MTU=1450` on a normal 1500-byte underlay. Do not continue workload validation unless the ConfigMap value is
1400 and fresh pod interfaces on every node report MTU 1400.

If VXLAN forwarding breaks, pods on one node cannot reach pods on another node, even though nodes may still appear
`Ready`.

This often shows up during bootstrap because Argo CD depends on cross-node networking (repo-server <-> redis-ha-haproxy <-> redis/sentinel, dex <-> server, etc.).

## Troubleshooting: MetalLB L2 VIP does not answer ARP

If a `Service` is `type: LoadBalancer`, shows an `EXTERNAL-IP`, but nothing on your LAN can reach it (often `arp -a` shows `(incomplete)` or connections hang), the VIP may not be getting advertised at L2.

### Symptom

1. `kubectl get svc -A` shows `EXTERNAL-IP` (example: `192.168.1.100`).
1. Clients on the same subnet fail to ARP for the VIP (no ARP reply), so `curl https://<vip>` / `nc -vz <vip> 443` fail.

### Cause (Talos default node label)

Talos commonly sets the node label `node.kubernetes.io/exclude-from-external-load-balancers` on control-plane nodes.

MetalLB treats nodes with that label as ineligible for external load balancers, so speakers will not advertise VIPs from those nodes.

### Fix

1. Remove the label from the nodes which should participate in external LBs:

```bash
kubectl label node <node-name> node.kubernetes.io/exclude-from-external-load-balancers-
```

2. Make it permanent by removing the label from the Talos machine config (for example in `devices/*/controlplane.yaml`) so it doesn't return after a reboot.

## Symptoms

1. `argocd-repo-server` CrashLoopBackOff due to liveness/readiness probe failures on `:8084/healthz`.
1. `argocd-redis-ha-server-*` init container logs contain timeouts to `argocd-redis-ha:26379`.
1. Requests to pod IPs on other nodes time out (DNS, Redis, etc.).

## Quick checks

1. Confirm flannel pods exist on every node:

```bash
kubectl -n kube-system get pods -l k8s-app=flannel -o wide
```

2. Check flannel VXLAN forwarding tables.

Pick one flannel pod (example: `kube-flannel-XXXX`) and inspect `flannel.1`:

```bash
kubectl -n kube-system exec kube-flannel-XXXX -c kube-flannel -- bridge fdb show dev flannel.1
```

Expected output includes one entry per remote node, for example:

`<vtep-mac> dst <node-ip> self permanent`

If the output is empty or missing remote nodes, cross-node pod networking will break.

3. Check VXLAN interface stats:

```bash
kubectl -n kube-system exec kube-flannel-XXXX -c kube-flannel -- ip -s link show flannel.1
```

If RX stays at `0` (or TX shows drops increasing rapidly), VXLAN encapsulated traffic is likely not being forwarded.

## Recovery (restart flannel)

Restart flannel on all nodes by deleting the DaemonSet pods:

```bash
kubectl -n kube-system delete pod -l k8s-app=flannel --force --grace-period=0
```

Wait for them to come back:

```bash
kubectl -n kube-system get pods -l k8s-app=flannel -o wide
```

Re-check the FDB:

```bash
kubectl -n kube-system exec kube-flannel-XXXX -c kube-flannel -- bridge fdb show dev flannel.1
```

## Verify cross-node connectivity

One simple verification is checking that a pod can reach CoreDNS on another node (replace IPs from `kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide`):

```bash
kubectl -n kube-system exec kube-flannel-XXXX -c kube-flannel -- nc -vz -w 2 <coredns-pod-ip> 53
```

Once cross-node networking is back, Argo CD redis HA init and repo-server probes should stabilize without further action.
