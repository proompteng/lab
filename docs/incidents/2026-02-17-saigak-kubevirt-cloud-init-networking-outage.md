# Incident Report: Saigak Unreachable After Talos Restart (KubeVirt + cloud-init Networking)

- **Date**: 16 Feb 2026 (PST) / 17 Feb 2026 (UTC)
- **Detected by**: Embeddings/memories requests failing (Jangar -> saigak) and direct `curl` timeouts to `saigak` service
- **Reported by**: gregkonush
- **Services Affected**: `saigak` (KubeVirt VM serving Ollama on `:11434`), downstream memories/embeddings via Jangar
- **Severity**: High (core dependency for embeddings; `saigak` endpoint unavailable)

## Impact Summary

- `saigak` became unreachable inside the cluster after the Talos node `talos-192-168-1-85` ("altra") restarted.
- Services that depended on the embedding endpoint (Jangar/memories) failed with connection errors and/or 500s.
- GPU itself remained present and allocatable on the node, but the VM service could not be reached until guest networking recovered.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| ~2026-02-17 06:xxZ | `talos-192-168-1-85` restarted; `saigak` VM comes back `Running` but service is unreachable. |
| ~2026-02-17 07:xxZ | Confirmed node GPU is present/allocatable and `virt-launcher-saigak-*` requests `nvidia.com/GA102_GEFORCE_RTX_3090: 1`. |
| ~2026-02-17 07:xxZ | Diagnosed KubeVirt masquerade path failing: `curl` to `saigak.saigak.svc:11434` times out; inside `virt-launcher` neighbor `10.0.2.2` is `FAILED/INCOMPLETE`. |
| ~2026-02-17 08:xxZ | Root cause isolated to guest networking: cloud-init shows `enp1s0` `Up=False` and no IP, so masquerade DNAT never reaches the guest. |
| ~2026-02-17 08:xxZ | Remediations applied via GitOps (ArgoCD) and `saigak` VMI restarted until guest NIC comes up and endpoints respond. |

## Root Cause

`saigak` is served from a KubeVirt VM using a pod network with `masquerade`. That setup relies on the guest NIC obtaining an IP via DHCP on the internal network (typically `10.0.2.0/24`, guest at `10.0.2.2`).

After the Talos node restart, the guest NIC (`enp1s0`) did not come up with a DHCP lease (cloud-init `ci-info` showed `enp1s0 Up=False` and no address). With no guest IP, KubeVirt's masquerade forwarding could not reach Ollama inside the VM, so the `saigak` Kubernetes Service timed out.

## Contributing Factors

- The VM's guest network configuration was not made robust across restarts:
  - NoCloud `network-config` handling was easy to get wrong (Secret key names and file format/schema).
  - VM identity drift (MAC/instance-id) made network behavior harder to reason about during repeated restarts.
- There was no explicit smoke test/alerting to catch "VM is Running but service is unreachable" immediately after node maintenance.

## What Was Not The Root Cause

- The NVIDIA device plugin / operator: the GPU remained present, allocatable, and was allocated to `virt-launcher-saigak-*`.
- KubeVirt VM scheduling: `saigak` remained pinned to `talos-192-168-1-85` and was running.

## Remediation Actions Taken

All changes were applied via GitOps (ArgoCD) in `argocd/applications/saigak/`:

1. **Provide a dedicated NoCloud `network-config` Secret and wire it in**:
   - Added `cloudInitNoCloud.networkDataSecretRef` on the VM to ensure KubeVirt generates a `network-config` file on the seed ISO.
   - Split user-data and network config into separate Secrets to avoid keying ambiguity.
2. **Correct the NoCloud network-config schema and lock down identity**:
   - Updated the network-config payload to a cloud-init compatible v1 schema for DHCP on `enp1s0`.
   - Set a stable VM firmware UUID and stable interface MAC so cloud-init instance identity and NIC identity remain consistent across restarts.
3. **Operational recovery**:
   - Restarted the `saigak` VMI to pick up the updated NoCloud seed data.
   - Verified in-guest cloud-init shows `enp1s0 Up=True` with `10.0.2.2`, and service endpoints respond.

## Validation

- From an in-cluster pod:
  - `GET http://saigak.saigak.svc.cluster.local:11434/api/version` returns the Ollama version.
  - `POST http://saigak.saigak.svc.cluster.local:11434/v1/embeddings` succeeds for `qwen3-embedding-saigak:0.6b`.
- `GET http://saigak.saigak.svc.cluster.local:11434/api/ps` shows the model is loaded and `size_vram > 0` (GPU-backed inference).
- ArgoCD `Application/saigak` reports `Synced` and `Healthy`.

## Follow-up Actions

- Add a runbook section for KubeVirt guest networking under masquerade:
  - Check guest `enp1s0` state from serial logs and confirm `network-config` is present on the NoCloud ISO.
- Add a lightweight smoke test (manual or automated) to run after node restarts:
  - `curl` `saigak` `/api/version` and a minimal `/v1/embeddings` request.
- Consider adding a CI check/lint that enforces:
  - `cloudInitNoCloud.networkDataSecretRef` is set for KubeVirt VMs that depend on DHCP under masquerade.
  - Stable MAC/UUID are present where cloud-init state must survive restarts.

## Relevant Commands

```bash
# Service reachability (in-cluster)
kubectl -n jangar run -it --rm curl --image=curlimages/curl:8.6.0 --restart=Never -- \
  sh -c 'curl -sS --max-time 10 http://saigak.saigak.svc.cluster.local:11434/api/version'

# Check NoCloud seed ISO content from virt-launcher
POD="$(kubectl -n saigak get pod -l kubevirt.io=virt-launcher -o jsonpath='{.items[0].metadata.name}')"
kubectl cp -n saigak "$POD:/var/run/kubevirt-ephemeral-disks/cloud-init-data/saigak/saigak/noCloud.iso" /tmp/noCloud.iso
bsdtar -tf /tmp/noCloud.iso
bsdtar -xOf /tmp/noCloud.iso network-config

# Serial logs show cloud-init network state
kubectl -n saigak exec "pod/$POD" -c compute -- sh -c \
  'tail -n 250 /var/run/kubevirt-private/*/virt-serial0-log | grep -n \"ci-info: | enp1s0\" | tail'

# GPU allocation verification
kubectl describe node talos-192-168-1-85 | rg 'nvidia.com/GA102_GEFORCE_RTX_3090|Allocated resources'
kubectl -n saigak get pod -l kubevirt.io=virt-launcher -o json | jq '.items[0].spec.containers[] | select(.name==\"compute\") | .resources'
```

