# Direct Firecracker Spike On Turin

This is a disposable runtime-substrate test for a future `MicroVM` controller.
It deliberately does **not** use AgentRun, KubeVirt, Kata, Flintlock, a custom
CRI, a RuntimeClass, persistent volumes, or a Talos system extension.

The spike creates one privileged launcher Pod pinned to `turin`. Inside that
Pod's namespaces and Kubernetes cgroup, it:

1. verifies `/dev/kvm`, `/dev/net/tun`, AMD SVM, and cgroup v2;
2. downloads checksum-pinned Firecracker v1.16.1, guest kernel 6.18.41, and the
   Firecracker CI Ubuntu 24.04 rootfs;
3. injects a tiny systemd guest agent and a vsock control endpoint;
4. starts Firecracker through its matching `jailer` as UID/GID 30000;
5. boots a 1-vCPU, 256-MiB microVM with TAP, MMDS v2, and virtio-vsock;
6. proves MMDS bootstrap, guest-to-host callback, outbound HTTPS, SSH access,
   host-to-guest vsock control, seccomp, jail UID, and Pod cgroup membership;
7. deletes the entire `microvm-spike` namespace and verifies its removal.

The launcher is privileged because creating TAP devices and invoking the jailer
requires capabilities that ordinary workload Pods must never receive. A real
controller must treat the launcher image and Pod template as trusted computing
base, enforce a narrow admission boundary, and map exactly one `MicroVM` object
to one launcher Pod.

## Run

From the repository root:

```bash
devices/turin/spikes/firecracker/run.sh
```

The default Kubernetes context is `galactic-tailscale`. Override it with
`KUBE_CONTEXT`. The combined proof log is written to
`/tmp/firecracker-turin-spike.log`. Cleanup is unconditional by default; set
`KEEP_RESOURCES=true` only while interactively diagnosing a failed run, then
delete the `microvm-spike` namespace yourself.

## Keep one microVM running

Create a long-lived launcher Pod whose readiness and liveness are tied to the
jailed Firecracker process:

```bash
devices/turin/spikes/firecracker/create-microvm.sh
```

The command leaves `microvm-demo/firecracker-turin-microvm` running on Turin.
The Pod becomes Ready only after the guest agent has bootstrapped through MMDS
v2 and the callback, outbound-networking, SSH, and vsock proofs have passed.
Inspect the launcher and enter the guest with:

```bash
kubectl --context galactic-tailscale --namespace microvm-demo \
  logs --follow pod/firecracker-turin-microvm

kubectl --context galactic-tailscale --namespace microvm-demo \
  exec --stdin --tty pod/firecracker-turin-microvm -- \
  ssh -i /work/id_ed25519 -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null root@172.16.0.2
```

Delete the Pod and its disposable root filesystem with:

```bash
devices/turin/spikes/firecracker/delete-microvm.sh
```

This is a privileged launcher Pod that owns one direct Firecracker microVM. It
does not turn Firecracker into a Kubernetes CRI runtime; that requires the
future controller and hardened launcher-image work described below.

## Boundary

This proves that direct Firecracker is viable on the existing Turin Talos node.
It is not the production launcher image, controller, CRD, network policy, image
distribution mechanism, snapshot pipeline, or multi-node rollout. No Talos
machine configuration is changed by this spike.
