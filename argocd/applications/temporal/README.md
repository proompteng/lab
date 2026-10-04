# Temporal

This Application owns Temporal's frontend, history, matching, and system worker, plus its retained persistence upgrade
resources. Helm chart 1.6.0 provides the server and UI manifests. The reviewed image pins remain in `kustomization.yaml`.

The system worker's CPU and memory reporting is built by
[services/temporal-worker](../../../services/temporal-worker/README.md). The Kustomize worker patch gives only that
Deployment its own Kustomize image name. Kargo's `temporal-worker` Stage updates that image entry on
`kargo/temporal-worker`; all other server components keep the upstream Temporal image.

Normal releases follow the [Kargo delivery contract](../../../docs/release-automation.md). Resource reporting is
accepted only after the new pod's exact image and current SDK heartbeat are verified and its worker UI no longer
shows the dependency warning. The worker restart creates a new worker instance key.

Do not re-run retained upgrade Jobs or prune persistence resources to enable resource reporting. Limit any authorized
manual synchronization to the exact promoted revision and affected worker Deployment after reviewing its live diff.
