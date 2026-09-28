# AmpereOne device configuration (ampone)

This directory is for the AmpereOne server ("ampone").

Current BMC/IPMI: `192.168.1.224`.
Current Talos node IP: `192.168.1.203`.

Docs:

- `devices/ampone/docs/cluster-bootstrap.md` (Talos install/bootstrap template)
- `devices/ampone/docs/volume-relayout.md` (repartition EPHEMERAL + local-path volumes)
- `devices/ampone/docs/ipmi.md` (IPMI/BMC command cookbook)
- `devices/ampone/docs/memory-upgrade-maintenance.md` (cordon/drain + IPMI shutdown for RAM work)
- `devices/ampone/docs/memory-troubleshooting.md` (DDR training + DIMM isolation notes)
- `devices/ampone/docs/relayout-volumes.md` (EPHEMERAL=300GB, local-path=rest)

Manifests:

- `devices/ampone/manifests/hostname.patch.yaml` (Talos hostname patch)
- `devices/ampone/manifests/install-nvme0n1.patch.yaml` (install to `/dev/nvme0n1`, wipe)
- `devices/ampone/manifests/allow-scheduling-controlplane.patch.yaml` (single-node: run workloads on the controlplane)
- `devices/ampone/manifests/ephemeral-volume.patch.yaml` (cap system `/var` to 300GB)
- `devices/ampone/manifests/local-path.patch.yaml` (allocate remainder to local-path user volume)
- `devices/ampone/manifests/kubelet-maxpods.patch.yaml` (set kubelet `maxPods` to 200)
