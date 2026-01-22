# Rebuild From Scratch: Kata + Firecracker on Talos (ryzen)

This is a complete, reproducible runbook to stand up Kata Containers with the
Firecracker VMM on Talos and prove it is working.

It assumes a single-node Talos cluster (ryzen) but works the same for multi-node
clusters (apply machine config to all nodes that should run Kata/Firecracker).

## High-level idea

Firecracker needs a **block-backed rootfs**. On Talos, the fastest working path
is the **containerd blockfile snapshotter** (not devmapper). Talos ships
`blockfile`, but disables it by default, so we must:

1. Remove `io.containerd.snapshotter.v1.blockfile` from `disabled_plugins` in
   `/etc/cri/containerd.toml`.
2. Configure blockfile snapshotter + `kata-fc` runtime in
   `/etc/cri/conf.d/20-customization.part`.
3. Create the scratch ext4 image under `/var`.
4. Reboot the node so containerd reloads config.
5. Run a test pod and verify Firecracker processes exist.

## Prereqs

- Talos v1.12.x node(s)
- KVM + vhost-vsock available: `/dev/kvm`, `/dev/vhost-vsock`
- Talos system extensions:
  - `siderolabs/kata-containers`
  - `siderolabs/glibc`
- `kubectl` configured with the `ryzen` context
- Talos config files in:
  - `/Users/gregkonush/github.com/devices/ryzen/controlplane.yaml`
  - `/Users/gregkonush/github.com/devices/ryzen/worker.yaml`

## Step 1: Build/Upgrade Talos with system extensions

Ensure Talos Image Factory schematic includes:

```yaml
customization:
  systemExtensions:
    officialExtensions:
      - siderolabs/kata-containers
      - siderolabs/glibc
```

Upgrade node with the resulting installer image (extensions only load at
install/upgrade time).

## Step 2: Update Talos machine config

### 2.1 Overwrite `/etc/cri/containerd.toml`

Talos disables blockfile in `disabled_plugins`. Remove it by overwriting the
base CRI containerd config.

Add this to `machine.files` in your Talos config (both controlplane + worker):

```yaml
- path: /etc/cri/containerd.toml
  op: overwrite
  permissions: 0o644
  content: |
    version = 3

    disabled_plugins = [
        "io.containerd.differ.v1.erofs",
        "io.containerd.internal.v1.tracing",
        "io.containerd.snapshotter.v1.erofs",
        "io.containerd.ttrpc.v1.otelttrpc",
        "io.containerd.tracing.processor.v1.otlp",
    ]

    imports = [
        "/etc/cri/conf.d/cri.toml",
    ]
```

### 2.2 Configure blockfile + kata-fc runtime

Add this to `/etc/cri/conf.d/20-customization.part` (via `machine.files`):

```toml
[plugins."io.containerd.snapshotter.v1.blockfile"]
  root_path = "/var/mnt/blockfile-scratch/containerd-blockfile"
  scratch_file = "/var/lib/containerd/blockfile-scratch/scratch.ext4"
  fs_type = "ext4"
  mount_options = []
  recreate_scratch = false

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc"]
  snapshotter = "blockfile"
  runtime_type = "io.containerd.kata-fc.v2"
  runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  pod_annotations = ["io.katacontainers.*"]
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc".options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"

[plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc"]
  snapshotter = "blockfile"
  runtime_type = "io.containerd.kata-fc.v2"
  runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  pod_annotations = ["io.katacontainers.*"]
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc".options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"
```

### 2.3 Apply Talos config and reboot

```bash
talosctl --talosconfig /Users/gregkonush/github.com/devices/ryzen/talosconfig \
  apply-config -n 192.168.1.194 -f /Users/gregkonush/github.com/devices/ryzen/controlplane.yaml

talosctl --talosconfig /Users/gregkonush/github.com/devices/ryzen/talosconfig \
  reboot -n 192.168.1.194
```

Wait for the node to return Ready:

```bash
kubectl --context=ryzen get nodes -o wide
```

## Step 3: Create the blockfile scratch image

The blockfile snapshotter requires a pre-created ext4/xfs scratch image.
Create it under `/var` so it survives reboots.

GitOps manifest (DaemonSet) lives at:

- `argocd/applications/kata-containers/blockfile-scratch-daemonset.yaml`

Apply via Argo CD (recommended) or manually apply the same manifest.

If applying manually, use the manifest below:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: blockfile-scratch-init
  namespace: kube-system
spec:
  restartPolicy: Never
  hostNetwork: true
  hostPID: true
  tolerations:
    - operator: Exists
  containers:
    - name: init
      image: debian:bookworm
      securityContext:
        privileged: true
      command:
        - bash
        - -euxo
        - pipefail
        - -c
        - |
          export DEBIAN_FRONTEND=noninteractive
          apt-get update
          apt-get install -y --no-install-recommends e2fsprogs util-linux

          ROOT=/host/var/lib/containerd/blockfile-scratch
          SCRATCH=${ROOT}/scratch.ext4
          SIZE=10G

          mkdir -p ${ROOT}

          if [ ! -f "${SCRATCH}" ]; then
            truncate -s ${SIZE} ${SCRATCH}
            mkfs.ext4 -F ${SCRATCH}
          else
            if ! dumpe2fs -h ${SCRATCH} >/dev/null 2>&1; then
              mkfs.ext4 -F ${SCRATCH}
            fi
          fi

          ls -lh ${SCRATCH}
          dumpe2fs -h ${SCRATCH} | head -n 10
      volumeMounts:
        - name: host-blockfile
          mountPath: /host/var/lib/containerd/blockfile-scratch
  volumes:
    - name: host-blockfile
      hostPath:
        path: /var/lib/containerd/blockfile-scratch
        type: DirectoryOrCreate
```

Apply and verify:

```bash
kubectl --context=ryzen apply -f blockfile-scratch-init.yaml
kubectl --context=ryzen -n kube-system get pod blockfile-scratch-init -o wide
kubectl --context=ryzen -n kube-system logs blockfile-scratch-init
```

## Step 4: Verify blockfile snapshotter is loaded

Containerd must show blockfile as a loaded snapshotter.

Use a temporary pod to run `ctr` against the host socket:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ctr-plugins-check
  namespace: kube-system
spec:
  restartPolicy: Never
  hostNetwork: true
  hostPID: true
  tolerations:
    - operator: Exists
  containers:
    - name: check
      image: debian:bookworm
      securityContext:
        privileged: true
      command:
        - bash
        - -euxo
        - pipefail
        - -c
        - |
          export DEBIAN_FRONTEND=noninteractive
          apt-get update
          apt-get install -y --no-install-recommends containerd
          ctr -a /host/run/containerd/containerd.sock plugins ls | grep -E -i 'snapshotter|blockfile|devmapper'
      volumeMounts:
        - name: host-run
          mountPath: /host/run
  volumes:
    - name: host-run
      hostPath:
        path: /run
        type: Directory
```

Expected output includes:

```
io.containerd.snapshotter.v1              blockfile                linux/amd64    ok
```

## Step 5: Fix pause image if needed

If you hit `content digest ... not found` for `registry.k8s.io/pause:3.10`,
re-pull it using host certs:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ctr-fix-pause
  namespace: kube-system
spec:
  restartPolicy: Never
  hostNetwork: true
  hostPID: true
  tolerations:
    - operator: Exists
  containers:
    - name: fix
      image: debian:bookworm
      securityContext:
        privileged: true
      command:
        - bash
        - -euxo
        - pipefail
        - -c
        - |
          export DEBIAN_FRONTEND=noninteractive
          apt-get update
          apt-get install -y --no-install-recommends containerd
          ctr -a /host/run/containerd/containerd.sock -n k8s.io images rm registry.k8s.io/pause:3.10 || true
          ctr -a /host/run/containerd/containerd.sock -n k8s.io images pull registry.k8s.io/pause:3.10
      volumeMounts:
        - name: host-run
          mountPath: /host/run
        - name: host-certs
          mountPath: /etc/ssl/certs
          readOnly: true
  volumes:
    - name: host-run
      hostPath:
        path: /run
        type: Directory
    - name: host-certs
      hostPath:
        path: /etc/ssl/certs
        type: Directory
```

## Step 6: Run the test pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kata-fc-test
  namespace: default
spec:
  runtimeClassName: kata-fc
  restartPolicy: Never
  containers:
    - name: busybox
      image: busybox:1.36
      command: ["sh", "-c", "echo kata-fc-ok && sleep 3600"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
```

Verify:

```bash
kubectl --context=ryzen get pod kata-fc-test -n default -o wide
kubectl --context=ryzen exec -n default kata-fc-test -- uname -a
```

Expected: pod Running and guest kernel from inside the VM.

## Step 7: Host-side proof

Confirm Firecracker process exists on the host:

```bash
talosctl --talosconfig /Users/gregkonush/github.com/devices/ryzen/talosconfig \
  processes -n 192.168.1.194 | rg -i 'firecracker|kata'
```

You should see `/firecracker --id ... --config-file /fcConfig.json`.

## Troubleshooting

### blockfile not loaded
- Ensure `/etc/cri/containerd.toml` no longer lists
  `io.containerd.snapshotter.v1.blockfile` under `disabled_plugins`.
- Reboot after config changes.

### pause image digest not found
- Re-pull `registry.k8s.io/pause:3.10` using host certs (Step 5).

### Pod stuck in `ContainerCreating`
- Check `kubectl describe pod` for `FailedCreatePodSandBox`.
- Check containerd logs:
  ```bash
  talosctl --talosconfig /Users/gregkonush/github.com/devices/ryzen/talosconfig \
    logs -n 192.168.1.194 containerd | rg -i 'kata|firecracker|blockfile'
  ```

## Cleanup (optional)

```bash
kubectl --context=ryzen -n kube-system delete pod \
  blockfile-scratch-init ctr-plugins-check ctr-fix-pause --ignore-not-found=true
```

## Notes

- Overwriting `/etc/cri/containerd.toml` means you now own that file; keep it
  minimal and only remove `blockfile` from `disabled_plugins`.
- For production, consider sizing the scratch image appropriately and storing
  it on fast local storage.
