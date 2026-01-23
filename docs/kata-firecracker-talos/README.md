# Kata + Firecracker on Talos

This doc records a working, Talos-friendly way to run Kata Containers with the
Firecracker VMM. Talos is immutable, so all custom config must be injected via
machine config and live under `/var`.

## Prereqs

- Talos system extensions for `kata-containers` and `glibc`.
- The kata extension ships `containerd-shim-kata-v2` under `/usr/local/bin` and
  a default config at `/usr/local/share/kata-containers/configuration.toml`.
- Firecracker VMM is **not** bundled in the stock extension; to use Firecracker,
  add a custom extension that includes `/usr/local/bin/firecracker` and point
  `ConfigPath` at a Firecracker config under `/var`.
- KVM + vsock available on the host (`/dev/kvm`, `/dev/vhost-vsock`).
- Containerd runtime config injected via `/etc/cri/conf.d/20-customization.part`.

## 1) Build/upgrade Talos with system extensions

Use Talos Image Factory and add system extensions in your schematic:

```yaml
customization:
  systemExtensions:
    officialExtensions:
      - siderolabs/kata-containers
      - siderolabs/glibc
```

Apply the schematic to a Talos installer image and upgrade the node. Extensions
only take effect at install/upgrade time.

## 1.1 GitOps scope (Argo CD)

On Talos we do **not** use the `kata-deploy` chart. It assumes a systemd host
and fails on Talos. Instead, the GitOps app installs only:

- Blockfile scratch DaemonSet
- `RuntimeClass` for `kata-fc`

Containerd runtime configuration is handled by Talos machine config.

If you need to apply these manually (no Argo CD), run:

```bash
kubectl --context=ryzen apply -n kube-system -f \
  argocd/applications/kata-containers/blockfile-scratch-daemonset.yaml
kubectl --context=ryzen apply -f \
  argocd/applications/kata-containers/runtimeclass-kata-fc.yaml
```

## 2) Create the blockfile scratch image (required, before enabling blockfile)

The blockfile snapshotter requires a pre-created scratch file (formatted ext4
or xfs). Create it under `/var` so it persists across reboots.

GitOps manifest (DaemonSet): `argocd/applications/kata-containers/blockfile-scratch-daemonset.yaml`

Important: create the scratch file **before** enabling the blockfile snapshotter in
Talos. If the snapshotter starts without the scratch file, `cri` fails and
etcd/kubelet cannot pull images.

```mermaid
flowchart TD
  A[OCI Image Layers] --> B[blockfile snapshotter]
  B --> C[Blockfile snapshot (ext4 image)]
  C --> D[Firecracker virtio-block]
  D --> E[Kata Guest RootFS]
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: blockfile-scratch-init
  namespace: kube-system
spec:
  restartPolicy: Never
  hostPID: true
  hostNetwork: true
  containers:
    - name: setup
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

          ROOT=/var/mnt/blockfile-scratch/containerd-blockfile
          SCRATCH=${ROOT}/scratch
          SIZE=10G

          mkdir -p $ROOT

          if [ ! -f "$SCRATCH" ]; then
            truncate -s $SIZE $SCRATCH
            mkfs.ext4 -F $SCRATCH
          else
            if ! dumpe2fs -h $SCRATCH >/dev/null 2>&1; then
              mkfs.ext4 -F $SCRATCH
            fi
          fi
```

## 3) Containerd runtime config (Talos machine config, after scratch exists)

Firecracker needs a block-device rootfs. On Talos, the fastest path is the
`blockfile` snapshotter, but Talos ships it **disabled** by default. You must
remove it from `disabled_plugins` and configure it for the `kata-fc` runtime.

```yaml
machine:
  files:
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
    - path: /etc/cri/conf.d/20-customization.part
      op: overwrite
      permissions: 0o644
      content: |
        [plugins."io.containerd.snapshotter.v1.blockfile"]
          root_path = "/var/mnt/blockfile-scratch/containerd-blockfile"
          scratch_file = "/var/mnt/blockfile-scratch/containerd-blockfile/scratch"
          fs_type = "ext4"
          mount_options = []
          recreate_scratch = false

        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc"]
          snapshotter = "blockfile"
          runtime_type = "io.containerd.kata-fc.v2"
          runtime_path = "/usr/local/bin/containerd-shim-kata-v2"
          privileged_without_host_devices = true
          pod_annotations = ["io.katacontainers.*"]
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc".options]
            ConfigPath = "/usr/local/share/kata-containers/configuration.toml"

        [plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc"]
          snapshotter = "blockfile"
          runtime_type = "io.containerd.kata-fc.v2"
          runtime_path = "/usr/local/bin/containerd-shim-kata-v2"
          privileged_without_host_devices = true
          pod_annotations = ["io.katacontainers.*"]
          [plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc".options]
            ConfigPath = "/usr/local/share/kata-containers/configuration.toml"
```

## 4) Firecracker config file (optional overrides)

Talos ships a default Kata configuration under:

```
/usr/local/share/kata-containers/configuration.toml
```

If you need Firecracker-specific overrides, place a new config under `/var` and
point `ConfigPath` to it. Avoid `shared_fs` for Firecracker; it needs block
devices.

## 5) RuntimeClass

The repo ships a `kata-fc` RuntimeClass in
`argocd/applications/kata-containers/runtimeclass-kata-fc.yaml`.
Verify:

```bash
kubectl get runtimeclass
```

If missing, create:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-fc
handler: kata-fc
```

## 6) Test pod

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

## 7) Example manifests (Firecracker workloads)

### Minimal Pod (Firecracker / kata-fc)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kata-fc-demo
  namespace: default
spec:
  runtimeClassName: kata-fc
  restartPolicy: Never
  containers:
    - name: busybox
      image: busybox:1.36
      command: ["sh", "-c", "echo kata-fc-demo-ok && sleep 3600"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
```

### Deployment (Firecracker / kata-fc)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kata-fc-web
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: kata-fc-web
  template:
    metadata:
      labels:
        app: kata-fc-web
    spec:
      runtimeClassName: kata-fc
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            runAsNonRoot: true
            runAsUser: 101
            seccompProfile:
              type: RuntimeDefault
```

## Troubleshooting

### blockfile snapshotter missing

If `ctr plugins ls` only shows `native` and `overlayfs`, Talos still has
`io.containerd.snapshotter.v1.blockfile` disabled. Ensure you overwrote
`/etc/cri/containerd.toml` and removed it from `disabled_plugins`, then reboot.

### snapshotter devmapper was not found

The containerd build on Talos does not expose the devmapper snapshotter. That
means Firecracker cannot mount a block-backed rootfs and will fail. Options:

- Build a custom Talos image/containerd with devmapper enabled.
- Use a supported OS/containerd build that ships devmapper.
- Switch Kata to a VMM that supports file sharing (QEMU/Cloud Hypervisor).

### Kata config not found

If `ConfigPath` is ignored, Kata falls back to default paths:

- `/etc/kata-containers/configuration.toml`
- `/usr/share/defaults/kata-containers/configuration.toml`

In Talos, keep custom files under `/var` and make sure `ConfigPath` points
there.
