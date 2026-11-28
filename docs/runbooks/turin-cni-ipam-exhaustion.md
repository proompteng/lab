# Recover Flannel cbr0 IPAM exhaustion on Turin and Altra

Turin exhausted its Flannel host-local IP pool with 172 orphaned leases among the 509 allocated addresses.
New AgentRun and ARC runner pods could not start even though not all addresses belonged to running pods.
Use this procedure on one node at a time:

| Node                 | PodCIDR         | Usable cbr0 addresses       |
| -------------------- | --------------- | --------------------------- |
| `turin`              | `10.244.0.0/23` | `10.244.0.2`–`10.244.1.254` |
| `talos-192-168-1-85` | `10.244.4.0/23` | `10.244.4.2`–`10.244.5.254` |

The 509-address capacity excludes the network address, the Flannel bridge gateway, and broadcast. The kubelet's
allocatable pod count is a separate limit.

## Confirm the failure

From the operator workstation, verify the Kubernetes context and Talos endpoint for the same node. See the
[Galactic access runbook](galactic-kubernetes-access.md) for access problems.

```sh
KUBE_CONTEXT=galactic-lan
NODE=turin
kubectl --context "$KUBE_CONTEXT" -n default get node "$NODE" \
  -o jsonpath='{.spec.podCIDRs}{" allocatable pods: "}{.status.allocatable.pods}{"\n"}'
for namespace in agents arc; do
  kubectl --context "$KUBE_CONTEXT" -n "$namespace" get pods \
    --field-selector "spec.nodeName=$NODE" -o wide
  kubectl --context "$KUBE_CONTEXT" -n "$namespace" get events \
    --field-selector reason=FailedCreatePodSandBox
done
```

Find the event for a pod assigned to the target node. Confirm that the message names host-local IPAM and
`no IP addresses available in range set`. Sandbox failures can also be caused by unrelated runtime or network errors.
On the same Talos endpoint, inspect `/run/flannel/subnet.env` and list `/var/lib/cni/networks/cbr0` using
`talosctl read` and `talosctl ls -l`. Verify the subnet matches the assigned PodCIDR and that the directory is
near capacity. Count only IP lease filenames, not `lock` or `last_reserved_ip.*`.

## Audit before archiving

Run the [lease audit CLI](../../packages/scripts/src/galactic/cni-cbr0-lease-audit.ts) from the reviewed checkout
in an authorized Linux maintenance session **on the target host**. On Talos, use a privileged host-PID,
host-network maintenance session that can access `/proc/1/root`. Use the approved Talos debug path if ordinary
pods cannot get a sandbox. Prepare Bun, `kubectl`, `ctr`, `flock`, the reviewed script and core module, and existing
read access to the Node and all Pod namespaces. Supply the kubeconfig through the session's existing private
credential mount, not in command arguments, manifests, or logs. Stop if an approved session or complete
Kubernetes/runtime read is unavailable; do not fall back to a cached Pod list.

Set `NODE` and `KUBE_CONTEXT` in that session to the values you verified. Set `HOST_ROOT=/proc/1/root` for the
host-PID session, or `HOST_ROOT=/` when running directly on the target host:

```sh
HOST_ROOT=/proc/1/root
umask 077
audit_cbr0() {
  bun run packages/scripts/src/galactic/cni-cbr0-lease-audit.ts \
    --context "$KUBE_CONTEXT" --node "$NODE" --host-root "$HOST_ROOT" "$@"
}
audit_cbr0 > cbr0-dry-run.json
jq -r '.results[] | select(.status == "orphan") | [.name, .ageSeconds] | @tsv' cbr0-dry-run.json
```

Dry-run is the default. The CLI verifies the host boot ID and PodCIDR, lists all Pods assigned to the node in
all namespaces **without filtering by phase**, and lists tasks from the host containerd socket in `k8s.io`.
It classifies each entry in the allocator directory. A lease is eligible only if it is in the usable range,
has a valid owner ID, has no matching Pod IP or containerd task, and its file mtime is at least 300 seconds old.
Unknown, malformed, out-of-range, and unsafe files stay untouched. Review the exact candidates before
proceeding; do not infer ownership from a count difference alone.

## Archive and verify recovery

1. With incident approval, cordon the affected node (`kubectl --context "$KUBE_CONTEXT" -n default cordon "$NODE"`).
   Do not drain or restart it as part of lease cleanup. Keep existing pods running; cordoning stops normal placement
   but does not stop kubelet retries.
2. From the same host session, run `audit_cbr0 --mode archive > cbr0-archive.json`. Archive mode obtains the
   existing allocator lock exclusively and repeats the audit with fresh API, task, and filesystem observations.
   It moves only leases still classified as orphaned, using same-filesystem renames into a new private
   directory under `/var/lib/cni/cbr0-archive-*` on the host. Do not move the allocation directory, lock, or cursor
   files. If the lock is busy, retry only after a fresh dry-run; do not remove or replace the lock.
3. Record the node, reviewed and archived IPs, and archive path in the incident record; keep raw receipts private.
   The CLI prints the archive path before it moves anything. If it fails partway through, inspect that directory
   and rerun a dry-run to reconcile before taking any further action. Do not automatically restore files.
4. Confirm `archived` contains only the expected orphaned leases and rerun the audit. Verify a previously blocked
   pod on the node acquires an IP, or use an approved targeted networking canary. Check DNS and Service
   connectivity, and verify new `no IP addresses available` events stop. If required to resume the blocked
   workflow, uncordon the node when ready and confirm an affected AgentRun or ARC runner starts successfully.
   Remove the temporary maintenance session when finished; retain the archive with the incident evidence.

### Restore one lease only if needed

If an archived file must be restored, keep the node cordoned (or re-cordon it) and recheck the Pod IP and
containerd inventories under the same allocator lock. A file can be moved back by its exact filename under
that lock only if the address has **not** been reassigned and the destination does not exist. Never overwrite
a current lease or bulk-restore the archive. If there is any uncertain or competing owner, leave the archive
intact and escalate rather than risking duplicate assignment.

## Prevention

- `FlannelCbr0IPAMCapacityHigh` warns after the running pod sandbox count is at least 80% of the 509-address pool
  for five minutes. The gauge includes host-network pods and cannot see leaked leases; a low ratio is not proof
  that free addresses remain.
- `FlannelCbr0SandboxFailures` pages when Prometheus estimates at least five sandbox-creation failures in five minutes.
  [Kubelet increments the counter in the `FailedCreatePodSandBox` event path](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/kuberuntime/kuberuntime_manager.go#L1601-L1622).
  Confirm the error text before treating the alert as an IPAM incident.
- After an observability rollout or kubelet upgrade, verify that `kubelet_running_pods` and
  `kubelet_started_pods_errors_total` are fresh in Mimir for both node labels. Missing series do not imply recovery.
  Use dry-run audits during runner-capacity reviews and investigate recurring orphans in Flannel/containerd.
  Keep runner concurrency below the measured pool headroom; do not schedule unattended archival.
- Revisit the rules and audit ranges together if either node's range, allocator, or reserved addresses change.
  Coordinate with the [PodCIDR and network ownership notes](../../devices/galactic/network/pod-100g-routing.md);
  do not change kubelet limits or CIDRs as an incident workaround.
