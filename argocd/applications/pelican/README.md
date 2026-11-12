# Pelican

Private Pelican Panel and a dedicated Wings guest, owned by the `pelican` Argo CD Application.

## Runtime

- Panel: `https://pelican.ide-newton.ts.net`, upstream `v1.0.0-rc.2`, pinned OCI digest.
- Wings: `https://pelican-wings.ide-newton.ts.net`, upstream `v1.0.0-rc.1`, checksum-verified binary.
- Game/SFTP endpoint: `pelican-games.ide-newton.ts.net`; TCP 2022 and UDP 10999/11000.
- Panel: one non-root replica, SQLite and application data on a retained 10 GiB Ceph PVC. `Recreate` prevents concurrent SQLite migrations and RWO writers.
- Wings: Ubuntu 24.04 KubeVirt guest on Turin, 4 vCPU, 6 GiB RAM and a retained 40 GiB Ceph disk. The Panel allows 4 GiB RAM and 24 GiB disk for games, reserving the remainder for the guest OS, Docker and images.

The namespace permits KubeVirt's privileged launcher. The Panel itself drops capabilities except `NET_BIND_SERVICE`, uses UID 82, disables privilege escalation, and receives no Kubernetes API token. Docker runs only inside the guest; Talos and the host container runtime stay unchanged. Panel ingress is restricted to the Tailscale proxy namespace. All endpoints stay private to the existing tailnet policy.

## Bootstrap and access

External Secrets generates independent encryption, administrator and Wings credentials once. The retained `pelican-bootstrap` Secret supplies the Panel initializer and the guest's cloud-init, so node credentials agree without granting either workload Kubernetes API permissions. The initializer creates the first administrator and node, preserves existing accounts/passwords, and rejects an encryption-key or Wings-token mismatch.

Initial login: username `greg`, email `admin@pelican.local`. Retrieve the initial password locally, without pasting it into logs or chat:

```sh
kubectl -n pelican get secret pelican-bootstrap -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 --decode
```

Change the administrator password and set a real email in the Panel after login. Mail delivery is intentionally unconfigured. The generated password remains a bootstrap record rather than resetting the live account on restart.

The forest/caves allocations are used by the [Don't Starve Together installation](dst/README.md).
Its one-time provisioning helper creates the game through Pelican's native services and
preserves subsequent user changes. Online activation requires the owner's Klei server token.
Public internet exposure requires a separate explicit networking change.

## Validation and operations

```sh
kubectl kustomize argocd/applications/pelican > /tmp/pelican.yaml
python3 argocd/applications/pelican/validate.py
bash scripts/kubeconform.sh argocd/applications/pelican argocd/applicationsets/platform.yaml
kubectl -n argocd get application pelican
kubectl -n pelican get externalsecret,pvc,datavolume,deploy,vm,vmi,ingress,service
kubectl -n pelican logs deployment/pelican -c initialize
```

The first installation runs 255 upstream migrations. A one-hour Deployment progress window accommodates cold-start storage latency without restarting the initializer or relaxing readiness. Investigate stalled migration logs or storage warnings rather than assuming a healthy rollout from elapsed time.

Validate actual login/installer closure and an authenticated Panel-to-Wings `/api/system` request after rollout. An Argo health indicator alone does not prove game execution. KubeVirt's guest-agent condition confirms that cloud-init installed the agent; inspect Wings independently.

Cloud-init installs Docker CE from its signed upstream Ubuntu repository and verifies the pinned Wings binary before enabling its service. Bootstrap is first-boot initialization: future guest software/configuration changes require an explicit in-guest update or a planned replacement preserving game data. Never recreate a used root disk as an update mechanism.

## Persistence and recovery

Back up the Panel PVC, the `pelican-bootstrap` Secret (especially `APP_KEY`), and the Wings disk together. Ceph replication and retention are not off-cluster backups. No backup schedule or external backup destination is created by this application.

PVC, DataVolume, VM and generated credentials carry retention safeguards. Recover by restoring the matching data and encryption key, then reconciling reviewed Git state through Argo CD. Roll back application code through Git; retain disks and credentials. Token rotation must update both the Panel node and guest configuration, plus the bootstrap Secret, in one planned operation.
