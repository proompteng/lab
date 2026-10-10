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

Prepared Tengri slots authenticate their host supervisor with a Pod-UID-specific `ClusterSPIFFEID`. Their Nanoagent
uses a private slot credential over vsock. Guest processes do not receive a Kubernetes API token or a SPIRE agent.
The old `galactic-guests` PSAT profile, guest bundle publisher and ConfigMap, token/registration RBAC, and static-entry
admission resources were retired after the approved old guests and their storage writers were fenced. Host `galactic`
attestation and `spire-system/spire-bundle` publication remain configured.

The Kubernetes Service exposes SPIRE gRPC only on port 443 and forwards it to the Pod listener on 8081.
The temporary listener-port alias has been removed.

Tengri's gRPC port requires mesh mTLS and admits only the Proompteng service-account principal. The applications also
verify exact SPIFFE peers and retain owner-bound request authorization. Public health/bootstrap and preview ports
remain outside mesh mTLS for the existing Traefik routes and retain their application authentication and network
policies. The slot supervisor verifies the controller's exact SPIFFE identity and the owner-bound slot claim before
forwarding an operation over its private guest connection. Guest execution does not share the supervisor's Workload
API mount or private key.

The server's built-in bundle publisher writes the host trust bundle to `spire-system/spire-bundle`. No signing keys or
workload private keys enter that ConfigMap. Namespace creation remains owned by the platform ApplicationSet.

## Talos configuration

Talos kubelet serving certificates use a node-specific CA and node DNS name. The agent chart's `hostCert` mode reads
the public `/var/lib/kubelet/pki/kubelet.crt` into an isolated volume. Kubelet TLS verification stays enabled. The
agent uses host networking to connect locally and validates the node hostname. The CSI driver uses
`/var/lib/kubelet`, matching Galactic's existing storage drivers. No Talos extension or machine configuration change
is required.

The public kubelet certificate is copied at agent startup. After a kubelet serving-certificate replacement, roll
the agents through a reviewed GitOps pod-template change so they load the replacement, then repeat verification.

## Persistence and availability

Three SPIRE servers share the dedicated `spire-db` PostgreSQL datastore through its primary Service. The CloudNativePG
cluster has three PostgreSQL 18.6 instances on distinct hosts, one synchronous standby, generated application
credentials, automatic primary failover, and daily Ceph volume-snapshot backups. The connection validates the server
certificate and hostname with the CNPG CA; no password is stored in Git or the server ConfigMap. No Prometheus server
is introduced.

SPIRE Pods also require distinct hosts and have a disruption budget keeping two servers available. Each server retains
its own signing keys on a 1 GiB `rook-ceph-block` PVC in the existing `proompteng.ai` subdirectory. The StatefulSet retains
PVCs when removed or scaled down. Namespace, datastore, and CRD pruning remain disabled. PostgreSQL stores the shared
registrations, attested agents, and trust bundles; it does not replace the signing-key volumes.

This configuration is the activation layer and must not reconcile until the offline SQLite import has committed and
the original signing-key volume is preserved. See [the migration procedure](migrate/README.md) for database preparation,
the maintenance window, activation order, failover verification, and recovery boundaries.

## Validation and recovery

The following trust-domain cutover notes describe the earlier migration. The PostgreSQL HA cutover preserves the
current trust domain, imports its existing datastore, and reuses the existing signing-key directory instead of resetting it.

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
