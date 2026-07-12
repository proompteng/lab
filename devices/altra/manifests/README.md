# altra manifests

Node/cluster patches used to install and join `altra` to the existing cluster.

Files:

- `devices/altra/manifests/hostname.patch.yaml`
- `devices/altra/manifests/install-nvme0n1.patch.yaml`
- `devices/altra/manifests/allow-scheduling-controlplane.patch.yaml`
- `devices/altra/manifests/controlplane-endpoint-nuc.patch.yaml`
- `devices/altra/manifests/ephemeral-volume.patch.yaml`
- `devices/altra/manifests/local-path.patch.yaml`
- `devices/altra/manifests/local-path-extra.patch.yaml`
- `devices/altra/manifests/nvidia-kernel-modules.patch.yaml`
- `devices/altra/manifests/node-labels.patch.yaml`
- `devices/altra/manifests/kubelet-maxpods.patch.yaml` (set kubelet `maxPods` to 500)
- `devices/altra/manifests/tailscale-extension-service.template.yaml`
- `devices/altra/manifests/tailscale-dns.patch.yaml`
- `devices/altra/manifests/altra-tailscale-nvidia-lts-schematic.yaml`
- `devices/altra/manifests/installer-image.tailscale-nvidia-lts.patch.yaml`

The 500-pod kubelet cap is a deliberate high-density exception; validate `/23`
PodCIDR allocation and node pressure before increasing ARC runner concurrency.
