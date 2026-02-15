# AmpereOne device configuration (ampone)

This directory is for the AmpereOne server ("ampone").

Current BMC/IPMI: `192.168.1.224`.
Current Talos node IP: `192.168.1.202`.

Docs:
- `devices/ampone/docs/cluster-bootstrap.md` (Talos install/bootstrap template)
- `devices/ampone/docs/ipmi.md` (IPMI/BMC command cookbook)
- `devices/ampone/docs/memory-troubleshooting.md` (DDR training + DIMM isolation notes)

Manifests:
- `devices/ampone/manifests/hostname.patch.yaml` (Talos hostname patch)
- `devices/ampone/manifests/allow-scheduling-controlplane.patch.yaml` (single-node: run workloads on the controlplane)
