# Troubleshooting: pod networking (flannel VXLAN)

This cluster uses flannel in VXLAN mode. If VXLAN forwarding breaks, pods on one node cannot reach pods on another node, even though nodes may still appear `Ready`.

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
