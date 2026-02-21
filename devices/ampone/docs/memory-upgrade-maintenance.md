# Ampone memory-upgrade maintenance (cordon, drain, IPMI power-off)

Goal: safely power down `ampone` for physical memory work while minimizing cluster risk.

Targets:
- Kubernetes node: `talos-192-168-1-203` (`ampone`)
- BMC/IPMI: `192.168.1.224`

## Preconditions / Safety

- Schedule a maintenance window.
- Keep the other control-plane nodes healthy and online (`192.168.1.85`, `192.168.1.194`).
- Understand impact:
  - `drain` may be blocked by PodDisruptionBudgets (PDBs).
  - forced drain (`--disable-eviction --force`) bypasses PDB protections and can cause downtime.
- Ensure IPMI credentials are available locally (see `devices/ampone/docs/ipmi.md`).

## 1) Cordon ampone

```bash
kubectl cordon talos-192-168-1-203

kubectl get node talos-192-168-1-203 \
  -o jsonpath='{.metadata.name}{" unschedulable="}{.spec.unschedulable}{"\n"}'
```

Expected: `unschedulable=true`.

## 2) Try a standard drain first

```bash
kubectl drain talos-192-168-1-203 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout=15m
```

## 3) If blocked by PDBs, force drain (maintenance-only)

Use this only when you intentionally accept disruption for hardware maintenance.

```bash
kubectl drain talos-192-168-1-203 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --disable-eviction \
  --force \
  --grace-period=60 \
  --timeout=10m
```

## 4) Verify the node is drained

```bash
kubectl get pods -A \
  --field-selector spec.nodeName=talos-192-168-1-203 \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,OWNER:.metadata.ownerReferences[0].kind,STATUS:.status.phase'
```

Expected:
- only `DaemonSet` and static control-plane pods (`OWNER=Node`) remain
- no regular workload Deployments/StatefulSets remain on this node

## 5) Power off via IPMI

```bash
export IPMI_PASSWORD="$(cat ~/.secrets/ampone-ipmi-password)"

ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power status
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power off
sleep 5
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power status
```

Expected final status: `Chassis Power is off`.

## 6) Confirm Kubernetes sees the node down

The API can lag briefly after power-off.

```bash
kubectl get node talos-192-168-1-203 \
  -o jsonpath='{.metadata.name}{" ready="}{range .status.conditions[?(@.type=="Ready")]}{.status}{" lastHeartbeat="}{.lastHeartbeatTime}{end}{" unschedulable="}{.spec.unschedulable}{"\n"}'

kubectl get lease -n kube-node-lease talos-192-168-1-203 \
  -o jsonpath='{.spec.renewTime}{"\n"}'
```

Expected shortly after shutdown:
- node transitions from `Ready=True` to `Ready=Unknown`/`NotReady`
- lease `renewTime` stops advancing

## 7) After memory upgrade: power on and return to service

```bash
export IPMI_PASSWORD="$(cat ~/.secrets/ampone-ipmi-password)"
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power on
```

Wait for node recovery:

```bash
kubectl get node talos-192-168-1-203 -w
```

When `Ready=True`, allow scheduling again:

```bash
kubectl uncordon talos-192-168-1-203
```

## References

- IPMI command cookbook: `devices/ampone/docs/ipmi.md`
- Memory troubleshooting signals and DIMM workflow: `devices/ampone/docs/memory-troubleshooting.md`
