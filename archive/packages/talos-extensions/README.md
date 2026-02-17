# Talos extensions (local)

This directory contains **local** Talos system extensions used by the lab
cluster. Extensions are built as OCI images containing a `manifest.yaml` and a
`rootfs/` directory.

## Firecracker extension

Path: `packages/talos-extensions/firecracker`

### Build (amd64)

```bash
docker buildx build \
  --platform=linux/amd64 \
  -t registry.ide-newton.ts.net/lab/firecracker:v1.12.1 \
  packages/talos-extensions/firecracker
```

### Push

```bash
docker buildx build \
  --platform=linux/amd64 \
  -t registry.ide-newton.ts.net/lab/firecracker:v1.12.1 \
  --push \
  packages/talos-extensions/firecracker
```

### Digest

```bash
crane digest registry.ide-newton.ts.net/lab/firecracker:v1.12.1
```
