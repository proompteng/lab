# Tigresse

This Argo CD application deploys the standalone Tigresse TigerBeetle operator from `proompteng/tigresse`
release `v0.1.2`.

The Helm chart is vendored from the release source so Argo CD can render without GHCR Helm registry
credentials. The operator image is served from the cluster-local registry and pinned by OCI index digest in
`values.yaml`.
