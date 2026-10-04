# Galactic SPIRE

The `spire-server`, `spire-system`, and `spire-test` Applications install SPIRE through the platform ApplicationSet.
The upstream SPIRE chart is pinned to `0.30.2`, SPIRE to `1.15.3`, and the CRD chart to `0.6.1`.
The two Helm applications use the existing Lovely renderer and its Helm 3 toolchain. The canary uses native Kustomize.

## Ownership and identity

The server and controller manager run in the restricted `spire-server` namespace. The agent and SPIFFE CSI driver
run in the privileged `spire-system` namespace. ApplicationSet owns namespace creation and security labels; these
applications render no Namespace objects. Helm install, upgrade, delete, and test hooks are excluded.
The server Application uses Argo's server-side diff so Kubernetes defaults on its StatefulSet and PVC template are
compared through an API server dry-run. Storage configuration remains part of the comparison.
The nested PVC template's generated `apiVersion` and `kind` are excluded from diff because Argo removes those two
fields from its predicted state. Capacity, storage class, access modes, and retention remain compared.

SPIRE and Istio use the single trust domain `proompteng.ai`. There is no default registration for other pods.
The controller registers `spire-test` canaries, Proompteng and Tengri application containers, their native Istio
proxies, and the two existing Istio gateways through explicit `ClusterSPIFFEID` resources. Namespace, Pod,
service-account, and container selectors constrain each registration. X.509-SVID lifetimes are two minutes.
Application containers use the Workload API directly; Istio proxies obtain their identities and trust bundles through
SPIRE's Envoy SDS API on a separate read-only CSI mount. Native sidecar injection uses the existing Istio CNI, so
restricted application Pods do not require a privileged network init container.
Proompteng and Tengri opt in through the `sidecar.istio.io/inject: "true"` Pod label. Their namespaces are not enrolled
globally; an injection annotation alone does not match Istio's object admission webhook in these namespaces.

The server authenticates agents with Kubernetes projected service account tokens restricted to
`spire-system:spire-agent` under the existing `galactic` profile. Agents inspect workload processes with host PID access,
root, and `SYS_PTRACE`, and query the secure kubelet endpoint. The SPIFFE CSI driver mounts the node's Workload API socket
into the registered application Pods.

Firecracker guest processes use their own rootless agent under `galactic-guests`. Only `tengri:nanoagent` PSATs for
audience `spire-server` are accepted, and the agent ID contains its attested Pod UID. Tengri creates a `ClusterStaticEntry`
whose parent is that agent and whose selector is `unix:uid:1000`; a Kubernetes admission policy prevents unrelated or
privileged registrations. A host `ClusterSPIFFEID` cannot describe this VM-local Unix process, because that controller
adds a host Kubernetes Pod selector to every registration.

The Kubernetes Service exposes SPIRE gRPC only on port 443 and forwards it to the Pod listener on 8081.
Guest clients use Service port 443. The temporary listener-port alias has been removed.

Tengri's gRPC port requires mesh mTLS and admits only the Proompteng service-account principal. The applications also
verify exact SPIFFE peers and retain owner-bound request authorization. Public health/bootstrap and preview ports
remain outside mesh mTLS for the existing Traefik routes and retain their application authentication and network
policies. Firecracker guests use their VM-local SPIRE agent and direct application mTLS; they do not receive host
Istio sidecars or a shared service-account identity in place of their Pod-specific identity.

This Application pre-creates `tengri/spire-guest-bundle` and name-restricted publisher RBAC at sync wave -1. The server's
built-in bundle publisher preserves `spire-system/spire-bundle` and also writes public PEM authorities to the guest
ConfigMap. ApplicationSet ignores only the generated `/data` field; namespace creation remains owned by the Tengri
Application. No signing keys or workload private keys enter these ConfigMaps.

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

The hard trust-domain cutover starts SPIRE with an empty `proompteng.ai` subdirectory on its retained server PVC.
An unprivileged init container prepares the directory, and the server mounts it as its complete data directory.
The previous database and signing keys remain outside that mount for recovery. They are not imported or trusted by
the new deployment. Host agents re-attest after their configuration changes; there are no trust-domain aliases,
federated old roots, or application allowlists accepting the previous domain.

Merge and publish the reviewed application changes through CI and Kargo, reconcile the server, agents, Istio
configuration and gateways, and use the owner Sleep/Resume action to replace retained guest Pods with the current
guest image. Keep each MicroVM and home PVC. This is a hard cutover with interrupted sessions until all participants
have re-attested. Verify the exact promoted application images, `proompteng.ai` SVIDs, SDS-issued proxy certificates,
renewal, both gRPC hops, and the authenticated desktop. A rollback must restore the complete previous configuration
and use the previous data mount; changing only the trust-domain string is insufficient.

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
