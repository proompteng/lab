# Tigresse

Tigresse is a Kubernetes operator that provisions [TigerBeetle](https://docs.tigerbeetle.com/) clusters using the [Kubebuilder](https://kubebuilder.io/) controller-runtime stack. The operator reconciles a `TigerBeetleCluster` custom resource into the ConfigMap, Services, and StatefulSet required to run the database following TigerBeetle’s deployment recommendations.

## Development

```bash
cd services/tigresse
GOFLAGS=-buildvcs=false go test ./...
```

Build and push the controller image with:

```bash
./scripts/build-tigresse.sh
```

Images publish to `registry.ide-newton.ts.net/lab/tigresse` and the
Argo CD deployment tracks the `latest` tag by default.

## Reconciliation responsibilities

- Maintain a bootstrap ConfigMap containing the DNS-aware startup script
- Manage headless and client Services for replica discovery
- Provision a StatefulSet with per-replica persistent volumes
- Surface `status.readyReplicas` from the StatefulSet to the custom resource status
