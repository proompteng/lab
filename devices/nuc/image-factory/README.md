# NUC Image Factory

This directory runs the community Sidero Labs Image Factory `v1.5.0` on the NUC. Omni uses it as the primary factory
for per-machine Talos schematics. The factory is reachable only on the Elauwit provider LAN at
`http://100.100.244.148:8081`; port `8080` remains owned by Pi-hole, and the backing OCI registry is private to the
Compose network.

The factory replaces the upstream extension catalog with the signed combined catalog published by
`.github/workflows/kata-firecracker-extension.yaml` at `ghcr.io/proompteng/talos-extensions:v1.13.9`. That catalog
contains every official Sidero Labs extension plus `proompteng/talos-kata-runtimes`. This is the supported community
path: the separate `enterprise.extraExtensions` feature is not required.

## Trust and persistent state

Input image verification stays enabled. The factory accepts only:

- Sidero Labs release identities issued by Google; and
- the `proompteng/lab` Kata workflow on `refs/heads/main`, issued by GitHub Actions OIDC.

The generated ECDSA key signs cached assets and custom installers. It lives at
`/var/lib/image-factory/secrets/cache-signing-key.key`, mode `0600`, and must be included in encrypted NUC backups.
The local registry and Image Factory temporary build storage also live below `/var/lib/image-factory`.

## Bootstrap and deploy

Run from the NUC checkout/copy of this directory:

```bash
cp .env.example .env
./bootstrap.sh
```

`bootstrap.sh` is idempotent: it creates the persistent directories and signing key once, validates that the NUC owns
`100.100.244.148/25`, pulls the digest-pinned images, starts both services, and verifies the signed Kata catalog.

Only after `verify.sh` passes, deploy the updated `devices/nuc/omni/omni.yaml` and restart the Omni container. Confirm
that Omni reports `http://100.100.244.148:8081/` as its primary Image Factory before changing any machine extensions.

Routine commands:

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs --tail 100 image-factory
./validate.sh
./verify.sh
```

## Catalog and installer cache semantics

`ghcr.io/proompteng/talos-extensions:v1.13.9` is a transport tag. Rollout authority is the signed catalog digest and
the digest-pinned `proompteng/talos-kata-runtimes` entry inside it. Confirm the live factory resolution before every
node phase. The accepted r4 catalog is
`ghcr.io/proompteng/talos-extensions@sha256:9cc2637cbf2ad061f5d39164ce558d71ab4608cdea702d42753f94d87539433a`:

```bash
export FACTORY='http://100.100.244.148:8081'
export EXPECTED_KATA_DIGEST='sha256:b7384435ad1393288e0235d8e467303348b252c2feb73973d309d07fee9afc44'

curl -fsS "$FACTORY/version/v1.13.9/extensions/official" \
  | jq -er '.[] | select(.name == "proompteng/talos-kata-runtimes") | .digest' \
  | grep -Fx "$EXPECTED_KATA_DIGEST"
```

`verify.sh` proves this catalog readback and a smoke schematic. It does not prove that every existing per-machine
installer cache entry was rebuilt. A schematic ID hashes the ordered customization request, not the resolved extension
image contents. Publishing a new digest under the catalog tag, restarting Image Factory, and receiving the same
schematic ID can therefore leave an older `metal-installer` manifest cached for that schematic and Talos version.

Before Omni reboots a target, capture its exact schematic customization with
`GET /schematics/<schematic-id>`, the current catalog digest readback, the generated installer manifest digest, and
factory or registry build evidence tying that installer to `EXPECTED_KATA_DIGEST`. Extension name/version, catalog
tag, schematic ID, or a successful pull is not sufficient. If that chain cannot be established, stop and rebuild or
invalidate only the target artifact through a reviewed procedure. The complete gate and rollout sequence are in
`docs/runbooks/talos-latest-upgrade-plan.md`.

### Rebuild exactly one cached installer

Run this only on the NUC, only for the reviewed target schematic, and only after recording the current manifest digest.
The expected-digest comparison prevents deleting a different or newly rebuilt manifest. The registry deletion removes
one top-level installer index; its shared blobs and every other schematic remain intact.

```bash
export SCHEMATIC_ID='<64-character target schematic ID>'
export TALOS_VERSION='v1.13.9'
export EXPECTED_OLD_INSTALLER_DIGEST='sha256:<64-character current index digest>'
export EXPECTED_KATA_DIGEST='sha256:b7384435ad1393288e0235d8e467303348b252c2feb73973d309d07fee9afc44'
export FACTORY='http://100.100.244.148:8081'

[[ "$SCHEMATIC_ID" =~ ^[0-9a-f]{64}$ ]]
[[ "$TALOS_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$EXPECTED_OLD_INSTALLER_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]

registry_container="$(docker compose --env-file .env ps -q registry)"
test -n "$registry_container"
registry_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "$registry_container")"
test -n "$registry_ip"
repository="image-factory/installers/metal-installer/$SCHEMATIC_ID"
manifest_url="http://${registry_ip}:5000/v2/${repository}/manifests/${TALOS_VERSION}"

current_digest="$(
  curl -fsSI \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "$manifest_url" \
    | tr -d '\r' \
    | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }'
)"
test "$current_digest" = "$EXPECTED_OLD_INSTALLER_DIGEST"

curl -fsS -X DELETE \
  "http://${registry_ip}:5000/v2/${repository}/manifests/${current_digest}"
curl -fsS -o /dev/null \
  "$FACTORY/v2/metal-installer/$SCHEMATIC_ID/manifests/$TALOS_VERSION"

rebuilt_digest="$(
  curl -fsSI \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "$manifest_url" \
    | tr -d '\r' \
    | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }'
)"
test -n "$rebuilt_digest"
test "$rebuilt_digest" != "$EXPECTED_OLD_INSTALLER_DIGEST"
docker compose --env-file .env logs image-factory \
  | rg -F -e "amd64-$EXPECTED_KATA_DIGEST" -e "arm64-$EXPECTED_KATA_DIGEST"
printf 'rebuilt installer: %s\n' "$rebuilt_digest"
```

Retain the old and new index digests, the selected architecture child digest and config creation time, and the matching
factory log line. If the schematic and Talos version did not change, continue with the same-schematic replacement
procedure in the cluster runbook; Omni will correctly report the machine as up to date and will not reinstall it.

## Omni handoff

The installer registry is HTTP on a private LAN. Before changing a schematic, apply this Talos config document to all
three machines through the exported Omni cluster template and wait until every pending config update has completed:

```yaml
apiVersion: v1alpha1
kind: RegistryMirrorConfig
name: 100.100.244.148:8081
endpoints:
  - url: http://100.100.244.148:8081
skipFallback: true
```

The exact Talos `v1.13.9` lifecycle path validates installer images with the system-containerd registry resolver, and
that resolver consumes `RegistryMirrorConfig`. The explicit `http://` endpoint is therefore used for both Talos-owned
installer pulls and CRI pulls. Without this mirror, an image reference such as
`100.100.244.148:8081/metal-installer/...` defaults to HTTPS and fails against this factory.

Then add `proompteng/talos-kata-runtimes` to each machine's `systemExtensions`, preserving its existing extensions:

| Machine                                        | Required extension set                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ryzen / `ff115a00-c307-11f0-a28f-648eab3e4100` | `siderolabs/amdgpu`, `siderolabs/amd-ucode`, `siderolabs/glibc`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes`                            |
| Turin / `8bf7ec00-171c-11f1-8000-7cc255f16774` | `siderolabs/nvidia-open-gpu-kernel-modules-lts`, `siderolabs/nvidia-container-toolkit-lts`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes` |
| Altra / `12345678-9abc-deff-1234-56789abcdeff` | `siderolabs/nvidia-open-gpu-kernel-modules-lts`, `siderolabs/nvidia-container-toolkit-lts`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes` |

The control-plane machine-set upgrade strategy must remain rolling with `maxParallelism: 1`. Change and sync only one
machine's extension list per phase. A new rollout uses Ryzen, Turin, Altra order; a resumed rollout finishes the
already-started machine first. Do not lock the cluster or unrelated machines. Start the next phase only after the
current target passes installer identity, Kubernetes, etcd, Ceph, drain, and all four runtime gates in the Galactic
runbook.
