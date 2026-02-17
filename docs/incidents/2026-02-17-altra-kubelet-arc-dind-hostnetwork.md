# Incident Report: Altra Kubelet Instability From ARC DinD + hostNetwork

- **Date**: 16 Feb 2026 (PST) / 17 Feb 2026 (UTC)
- **Detected by**: Talos dashboard showing kubelet unhealthy and Kubernetes node `NotReady`
- **Reported by**: gregkonush
- **Services Affected**: Kubernetes control-plane node `talos-192-168-1-85` ("altra"), ARC runner jobs (`arc` namespace)
- **Severity**: High (control-plane node disruption; reduced redundancy)

## Impact Summary

- Control-plane node `talos-192-168-1-85` became `NotReady` and stopped posting node status.
- Kubelet on `altra` was stuck stopping for an extended period and could not recover without intervention.
- ARC runner workloads on `altra` were left in a broken state (pods reported `Unknown`), and new jobs could be delayed until the node recovered.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| ~2026-02-17 06:2xZ | `altra` observed `NotReady`; Talos shows kubelet unhealthy and/or stuck stopping. |
| ~2026-02-17 06:3xZ | Investigation finds ARC runner pods configured with `hostNetwork: true` and a privileged `docker:dind` sidecar. Host networking shows unexpected `docker0` bridge address (`172.17.0.1/16`) on the node. |
| ~2026-02-17 06:4xZ | GitOps fix applied to ARC to remove `hostNetwork: true` from runner/listener templates. |
| ~2026-02-17 06:5xZ | Node recovered after a forced Talos reboot; kubelet returns to healthy and node becomes `Ready`. |

## Root Cause

ARC runner pods were configured to run with `hostNetwork: true` while also running a privileged Docker-in-Docker (`docker:dind`) sidecar.

With `hostNetwork: true`, the DinD daemon's bridge (`docker0`) and iptables/NAT rules are created in the node network namespace. This polluted the host's networking (e.g., `docker0` showing as a host address) and correlated with kubelet instability on `altra` (kubelet stuck stopping, node status becoming unknown).

## Contributing Factors

- Running ARC runners on a Talos control-plane node increased blast radius of the host networking side-effects.
- Privileged DinD is inherently invasive; combining it with host networking makes those effects host-wide.
- The failure mode was non-obvious because the ARC pod spec looked "reasonable" for DinD, but the host networking aspect changed the containment boundary.

## What Was Not The Root Cause

- The ARC `docker:dind` sidecar itself is not the issue; DinD can work without host networking.
- Talos/Kubernetes versions were not changed during the incident; the behavior tracked to workload configuration.

## Remediation Actions Taken

1. **GitOps change**: removed `hostNetwork: true` (and `dnsPolicy: ClusterFirstWithHostNet`) from ARC listener/runner templates in `argocd/applications/arc/application.yaml`.
2. **Node recovery**: performed a forced Talos reboot on `altra` when kubelet would not recover cleanly.
3. **ARC cleanup**: deleted any remaining runner pods created with the old hostNetwork spec so they could be recreated with the corrected configuration.

## Follow-up Actions

- Add a guardrail to prevent reintroducing `hostNetwork: true` into ARC runner/listener templates (CI policy check or pre-commit grep for ARC manifests).
- Consider restricting ARC runners to non-control-plane nodes (taints/affinity) to reduce blast radius.
- Keep a short Talos recovery checklist for kubelet `Stopping` / node `NotReady` investigations (services state, addresses, and recent workload changes).

## Lessons Learned

- `hostNetwork: true` is a high-risk setting on Talos control-plane nodes, especially with privileged workloads.
- DinD does not require host networking; keeping it in the pod network namespace avoids host bridge/iptables pollution.
- When Talos reports kubelet stuck stopping, a forced reboot may be necessary to break a deadlock, but only after removing the triggering workload configuration.

## Relevant Commands

```bash
# Node / kubelet state
talosctl services -n 192.168.1.85 -e 192.168.1.85
talosctl logs kubelet -n 192.168.1.85 -e 192.168.1.85 --tail=200
talosctl get nodeip -n 192.168.1.85 -e 192.168.1.85 -o yaml
talosctl get addresses -n 192.168.1.85 -e 192.168.1.85

# Identify ARC runners using host networking
kubectl -n arc get pods -o json | jq -r '.items[] | select(.metadata.name|test(\"runner\")) | [.metadata.name,(.spec.hostNetwork//false)] | @tsv'

# Force reboot when kubelet is wedged
talosctl reboot -n 192.168.1.85 -e 192.168.1.85 --mode=force --debug
```
