# Galactic SPIRE

The `spire-server`, `spire-system`, and `spire-test` Applications install SPIRE through the platform ApplicationSet.
The upstream SPIRE chart is pinned to `0.30.2`, SPIRE to `1.15.3`, and the CRD chart to `0.6.1`.
The two Helm applications use the existing Lovely renderer and its Helm 3 toolchain. The canary uses native Kustomize.

## Ownership and identity

The server and controller manager run in the restricted `spire-server` namespace. The agent and SPIFFE CSI driver
run in the privileged `spire-system` namespace. ApplicationSet owns namespace creation and security labels; these
applications render no Namespace objects. Helm install, upgrade, delete, and test hooks are excluded.

The SPIRE trust domain is `galactic.proompteng.ai`. Existing Istio certificates continue to use `cluster.local`.
This rollout does not change Istio or application authentication. There is no default registration for other pods.
The controller registers only pods in `spire-test` with the canary label and `identity-canary` service account.

The server authenticates agents with Kubernetes projected service account tokens restricted to
`spire-system:spire-agent`. Agents inspect workload processes with host PID access, root, and `SYS_PTRACE`, and query
the secure kubelet endpoint. The SPIFFE CSI driver mounts each node's Workload API socket into the canary pods.

## Talos configuration

Talos kubelet serving certificates use a node-specific CA and node DNS name. The agent chart's `hostCert` mode reads
the public `/var/lib/kubelet/pki/kubelet.crt` into an isolated volume. Kubelet TLS verification stays enabled. The
agent uses host networking to connect locally and validates the node hostname. The CSI driver uses
`/var/lib/kubelet`, matching Galactic's existing storage drivers. No Talos extension or machine configuration change
is required.

The public kubelet certificate is copied at agent startup. After a kubelet serving-certificate replacement, roll
the agents through a reviewed GitOps pod-template change so they load the replacement, then repeat verification.

## Persistence and availability

One server stores its SQLite database and signing keys on a 1 GiB `rook-ceph-block` PVC. The StatefulSet retains its
PVC when removed or scaled down. Namespace and CRD pruning are disabled. This is a single-server deployment;
server downtime prevents new issuance and renewal, while previously issued credentials remain valid until expiry.
Multiple server replicas require a shared supported database before increasing the replica count.

## Validation and recovery

Render both Helm applications with Helm 3 and render the canary with Kustomize. Validate the rendered Kubernetes
resources and the ApplicationSet before merge. Root reconciliation must update only the platform ApplicationSet
at the reviewed main commit; the three child Applications then reconcile their committed desired state.

The canary DaemonSet watches its X.509 identity on every Linux node. Its registration has a two-minute TTL so the
verifier can observe rotation promptly. Run:

```sh
python3 argocd/applications/spire-server/verify.py --context galactic-tailscale
```

The verifier requires ready server, agent, and CSI workloads, a canary on every node, AMD64 and ARM64 coverage,
the expected SPIFFE ID, at least two distinct certificate validity windows per canary, a currently valid identity,
and denial for an unregistered workload. It reads metadata only and prints no certificates, keys, or tokens.

For recovery, revert the affected values or workload templates through a reviewed main change and reconcile that
revision. Preserve the server PVC and CRDs. Restore the datastore and signing keys together if storage recovery is
necessary. Removing a workload registration revokes eligibility for new credentials; issued credentials can remain
usable until their expiry.
