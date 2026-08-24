# Kata multi-runtime Talos extension

This is one Talos system extension for `linux/amd64` and `linux/arm64`. It installs Kata Containers `4.1.0`
`runtime-rs` and exposes four containerd handlers:

| RuntimeClass      | Kata handler      | VMM                  | Root filesystem                        |
| ----------------- | ----------------- | -------------------- | -------------------------------------- |
| `kata-qemu`       | `kata-qemu`       | QEMU                 | containerd overlayfs through virtio-fs |
| `kata-clh`        | `kata-clh`        | Cloud Hypervisor     | containerd overlayfs through virtio-fs |
| `kata-fc`         | `kata-fc`         | Firecracker `1.12.1` | containerd `blockfile` snapshotter     |
| `kata-dragonball` | `kata-dragonball` | built-in Dragonball  | inline virtio-fs                       |

There is no custom controller, CRD, AgentRun, privileged launcher, or KubeVirt dependency. Kubernetes creates a Pod
with `runtimeClassName`; containerd invokes the shared Kata shim; the selected Kata configuration starts and owns the
guest VM.

## Contents

- `/etc/cri/conf.d/10-kata-runtimes.part`: blockfile snapshotter plus the four CRI handlers;
- `/usr/local/bin/containerd-shim-kata-v2`: the shared Kata `runtime-rs` shim;
- QEMU, Cloud Hypervisor, Firecracker, jailer, and virtiofsd executables;
- the Kata guest image, standard guest kernel, and Dragonball guest kernel;
- a deterministic 512 MiB ext4 scratch image for containerd's blockfile snapshotter;
- architecture-specific QEMU firmware and data files.

The Kata `4.1.0` arm64 release archive contains the Cloud Hypervisor binary but omits its generated configuration.
`configuration-clh-runtime-rs.toml` is the generated config from the same `4.1.0` release archive with only
`/opt/kata` rewritten to Talos' `/usr/local` extension prefix. The configuration is architecture-neutral; upstream
runtime-rs and virtualization documentation support Cloud Hypervisor on x86_64 and aarch64.

## Build

The accepted r4 release was built for both architectures, signed with Cosign, added to the signed combined `v1.13.9`
extension catalog, and assembled into three architecture-specific Talos installers:

- `ryzen-amd64`: Kata plus AMDGPU, AMD microcode, glibc, and Tailscale;
- `turin-amd64`: Kata plus the NVIDIA LTS kernel/toolkit extensions and Tailscale;
- `altra-arm64`: Kata plus the NVIDIA LTS kernel/toolkit extensions and Tailscale.

For a local extension-only validation:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag talos-kata-runtimes:validation \
  devices/galactic/extensions/kata
```

The checked-in workflow now validates both architectures without publishing. The installed r4 release remains pinned
to its existing immutable GHCR receipts; this repository move does not rebuild or replace it. Any future publication
must use `registry.ide-newton.ts.net`, and consuming that release is a separate node-image rollout.

To reproduce an existing installer, use only the immutable extension digest recorded in the release receipt:

```bash
devices/galactic/extensions/kata/build-installer.sh \
  ryzen-amd64 \
  ghcr.io/proompteng/talos-kata-runtimes@sha256:<extension-digest> \
  _out/kata-runtimes/ryzen
```

## Activation

Installing the extension changes the immutable Talos installer and reboots the node. Roll out one node at a time only
after the Kubernetes and etcd gates in the cluster runbook pass. Record Ceph health and flags for each phase; the
current Galactic operator policy does not block this rollout on Ceph state. The custom installer replaces the stock
Kata extension; it does not install both copies.

Installer convergence is not runtime acceptance. The installed extension resource exposes only the extension name and
version, not the source OCI digest. Before reboot, tie the exact generated installer to the signed extension digest in
`RELEASE-v4.1.0-talos-v1.13.9.md`; an unchanged Image Factory schematic ID or `kata-runtimes` version `4.1.0` is
insufficient because a cached installer may have been assembled from an older digest.

Omni does not select these installers from a `machine.install.image` config patch. The NUC Image Factory reads the
signed combined catalog and generates the desired per-machine schematic from each machine's `systemExtensions`. See
`devices/nuc/image-factory/README.md` for the factory and registry-mirror handoff.

If a corrected extension rebuild replaces the cached installer while its schematic ID and Talos version remain
unchanged, Omni correctly reports the machine as up to date. The cluster runbook documents the only direct-install
exception for that state: prove the new manifest digest, finish a target-only drain with no concurrent Omni task, run
the exact installer on that already-drained node, and keep it cordoned until all four runtime proofs pass.

Talos disables containerd's built-in `blockfile` snapshotter in `/etc/cri/containerd.toml`, and its default CRI image
settings discard layer blobs after overlayfs unpack. Each Kata-enabled machine patch in
`devices/galactic/omni/cluster-template.yaml` therefore removes only `io.containerd.snapshotter.v1.blockfile` from
`disabled_plugins` and sets `discard_unpacked_layers = false` plus `use_local_image_pull = true` in
`/etc/cri/conf.d/20-customization.part`. Omni applies those files and restarts CRI; without both settings,
Firecracker fails before guest boot. Local pull mode is required because containerd's transfer-service pull path does
not support the CRI `discard_unpacked_layers` option; retaining the compressed layer blob lets the runtime-specific
`blockfile` snapshotter unpack an image that was already used by an overlayfs runtime.

Enabling retention cannot recreate compressed layers that containerd discarded earlier. Before a node's first
Firecracker canary after this migration, fetch content only for both pinned sandbox images: the Kubernetes pause image
and `ghcr.io/proompteng/nanoagent`. Use the digest-pinned
`ghcr.io/containerd/nerdctl@sha256:ddf262a8a129c7e625e640480da6d740019891ecf8f8dda545d0d76652c1986a`
debug image with the host containerd socket and `ctr --namespace k8s.io content fetch --platform <linux/amd64|linux/arm64>`.
The exact command is in `docs/runbooks/talos-latest-upgrade-plan.md`. This recovery restores missing OCI content only;
never prune shared containerd content or snapshots.

Argo CD application `kata` owns the RuntimeClasses and, after publishing Nanoagent, the long-running
canary DaemonSets. Each RuntimeClass has an independent node selector, so installing a handler does not make a node
eligible by itself.

The Kubernetes package is deliberately separate from this node extension under `argocd/applications/kata`. The Argo
application and its canaries use namespace `kata`; the installed Talos extension identity remains `kata-runtimes`.

The Nanoagent rename changes the four DaemonSet resource identities. Its first sync must enable pruning so Argo CD
deletes the superseded `microvm-agent-{qemu,clh,fc,dragonball}` DaemonSets instead of running both generations:

```bash
argocd app sync kata --prune
kubectl --context galactic-lan -n kata get daemonsets
```

Only `nanoagent-qemu`, `nanoagent-clh`, `nanoagent-fc`, and `nanoagent-dragonball` may remain. The runtime verifier
rejects the rollout if any legacy DaemonSet is still present.

Omni normally uncordons a node when its reboot lifecycle finalizes. Immediately cordon the returned node again for
runtime validation and require `Ready,SchedulingDisabled` before applying any runtime label:

```bash
kubectl --context galactic-lan cordon <node>
kubectl --context galactic-lan get node <node>
```

The DaemonSet controller tolerates the built-in unschedulable taint, so these canaries still run on the validation-
cordoned target. Keep this cordon until all four runtime proofs pass. It is an acceptance barrier, separate from Omni's
temporary transport cordon.

For each node and runtime, first verify the extension, containerd service, and handler configuration. Then add only
that runtime's activation label, let its canary boot, and collect guest plus host-side VMM evidence. Remove the label
immediately if the canary fails; retain it only after the proof passes:

```bash
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-qemu=ready --overwrite
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-clh=ready --overwrite
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-fc=ready --overwrite
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-dragonball=ready --overwrite
```

The four canaries remain running for inspection. `verify-runtimes.sh` captures their guest boot IDs and kernel
releases, proves `/bin/sh`, Nanoagent PID 1, and writable `/workspace` behavior inside each guest, maps each Pod to its
Talos CRI sandbox, and verifies the requested host VMM. Dragonball is built into the Kata shim, so it deliberately has
no separate VMM process.

Only after QEMU, Cloud Hypervisor, Firecracker, and Dragonball have each passed on the target may the node be accepted
and uncordoned:

```bash
kubectl --context galactic-lan uncordon <node>
kubectl --context galactic-lan get node <node>
```

On any failure, remove only the failed runtime label, retain the evidence, leave the node validation-cordoned, and do
not change the next machine's desired schematic.

The signed r4 installer is accepted on Ryzen, Turin, and Altra. The final 12-combination receipt, immutable digests,
guest boot IDs, host VMM evidence, and the two hardware-specific reboot recoveries are recorded in
`RELEASE-v4.1.0-talos-v1.13.9.md`.

## Create a shell-capable Nanoagent microVM Pod

After `kata-fc` has passed acceptance on at least one uncordoned node, an ordinary Pod creates a Firecracker microVM
sandbox. No CRD, custom controller, privileged launcher, or nested QEMU process is involved. The RuntimeClass injects
the node selector for an accepted Firecracker node:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nanoagent-example
  namespace: kata
spec:
  runtimeClassName: kata-fc
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    fsGroup: 65532
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: nanoagent
      image: ghcr.io/proompteng/nanoagent@sha256:78b7b6e52e9b3f6003d2663a5e85fbfb55eabba018a6ee61f6b39a722f71ad7c
      env:
        - name: MICROVM_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.uid
        - name: MICROVM_BOOTSTRAP_TOKEN
          valueFrom:
            secretKeyRef:
              name: nanoagent-bootstrap
              key: token
      ports:
        - name: http
          containerPort: 8080
      readinessProbe:
        httpGet:
          path: /healthz
          port: http
      resources:
        requests:
          cpu: 25m
          memory: 32Mi
        limits:
          cpu: 500m
          memory: 512Mi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 65532
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      emptyDir:
        sizeLimit: 256Mi
```

Create the referenced Secret through the workload's normal secret-management path, then apply the Pod with an explicit
namespace. `kubectl get pod -n kata -o wide` must place it only on a node labeled
`runtime.proompteng.ai/kata-fc=ready`. One Pod sandbox is one microVM; multiple containers in the same Pod share that
guest. Use `kata-qemu`, `kata-clh`, or `kata-dragonball` to select another accepted VMM.

Nanoagent contains BusyBox `/bin/sh` and runs as non-root with a writable `/workspace`. Enter the same container that
runs the agent process; no shell sidecar or SSH service is required:

```bash
kubectl --context galactic-lan -n kata exec -it nanoagent-example -c nanoagent -- /bin/sh
```

Firecracker cannot use an overlayfs root inside the guest. Its handler alone selects containerd `2.2`'s built-in
`blockfile` snapshotter. The bundled 512 MiB scratch filesystem limits each ephemeral container root filesystem to
512 MiB; persistent data belongs on Kubernetes volumes. The Firecracker configuration caps `default_maxvcpus` at
32, matching Firecracker `1.12.1`; leaving Kata's generated value at `0` expands it to the host CPU count and makes
runtime validation fail on Turin's 128-CPU host. It also uses a 100 ms initial VMM socket dial with a 45-second
reconnect budget so runtime-rs can wait for Firecracker startup without sleeping 45 seconds between attempts.
