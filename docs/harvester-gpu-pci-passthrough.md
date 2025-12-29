# Harvester GPU PCI passthrough (RTX 3090 → `docker-host`)

This note documents how we pass the NVIDIA GA102 GPU on the `altra` Harvester node through to the `docker-host` VM (`kalmyk@192.168.1.190`).

## What this does (and doesn’t)
- Enables Harvester PCI passthrough for `000c:01:00.0` (RTX 3090) so KubeVirt can assign it to a VM.
- Attaches the GPU to `default/docker-host` via the KubeVirt `VirtualMachine` spec.
- Does **not** attach the GPU’s audio function (`000c:01:00.1`) to the VM.

Important: even if you don’t want audio in the guest, the VGA + audio functions share the same IOMMU group on this host (group `18`). Harvester/KubeVirt can refuse the GPU unless the group is fully “claimed/known”. In practice we keep a `PCIDeviceClaim` for `000c:01:00.1`, but we do not attach it to the VM.

## Inventory
From your workstation:

```bash
kubectl --kubeconfig ~/.kube/altra.yaml -n default get pcidevices.devices.harvesterhci.io -o wide
```

Expected devices:
- GPU: `altra-000c01000` (`000c:01:00.0`, resource name `nvidia.com/GA102_GEFORCE_RTX_3090`)
- Audio: `altra-000c01001` (`000c:01:00.1`, resource name `nvidia.com/GA102_HIGH_DEFINITION_AUDIO_CONTROLLER`)

## Declarative resources (stored in-repo)
These templates are the “source of intent” for passthrough on `altra`:
- `tofu/harvester/templates/pcideviceclaim-altra-000c01000.yaml` (claim GPU + enable passthrough)
- `tofu/harvester/templates/pcideviceclaim-altra-000c01001.yaml` (claim audio function so the IOMMU group is fully tracked)
- `tofu/harvester/patches/vm-docker-host-nvidia-gpu.patch.json` (merge-patch to attach GPU to the VM)

## Why this isn’t in `tofu/harvester/main.tf`
We can’t express “attach this PCI device to the VM” through the `harvester/harvester` OpenTofu provider today (even on the latest provider release — `v1.6.0` as of 2025-12-15). The workaround is to apply the Harvester CRDs (`PCIDeviceClaim`) and patch the underlying KubeVirt `VirtualMachine` spec directly via `kubectl`.

## Apply (cluster)
Apply the claims:

```bash
kubectl --kubeconfig ~/.kube/altra.yaml apply -f tofu/harvester/templates/pcideviceclaim-altra-000c01000.yaml
kubectl --kubeconfig ~/.kube/altra.yaml apply -f tofu/harvester/templates/pcideviceclaim-altra-000c01001.yaml
```

Patch the VM to attach the GPU:

```bash
kubectl --kubeconfig ~/.kube/altra.yaml -n default patch vm docker-host \
  --type merge \
  --patch-file tofu/harvester/patches/vm-docker-host-nvidia-gpu.patch.json
```

Restart the running instance so the new device assignment takes effect:

```bash
kubectl --kubeconfig ~/.kube/altra.yaml -n default delete vmi docker-host
```

## Verify
Wait for it to come back:

```bash
kubectl --kubeconfig ~/.kube/altra.yaml -n default get vmi docker-host -o wide
```

Then validate inside the VM:

```bash
ssh kalmyk@192.168.1.190
sudo lspci -nn | grep -i nvidia
```

## Troubleshooting
- If the VM gets stuck `Pending` with `GPU ... is not permitted in permittedHostDevices configuration`, ensure the `harvester-pcidevices-controller` has created a device plugin for `nvidia.com/GA102_GEFORCE_RTX_3090` and requeue/restart it if needed:
  - `kubectl --kubeconfig ~/.kube/altra.yaml -n harvester-system get pods | grep harvester-pcidevices-controller`
  - `kubectl --kubeconfig ~/.kube/altra.yaml -n harvester-system logs <pod> -c agent --tail=200`
- If the admission webhook says the GPU resource name is not found in the PCI device cache, wait a few seconds and retry the VM patch, or restart the `harvester-pcidevices-controller` pod.
