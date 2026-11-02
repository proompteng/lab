# Tigresse

This Argo CD application deploys the standalone Tigresse TigerBeetle operator from `proompteng/tigresse`
release `v0.1.8`.

The Helm chart is vendored from the published release so Argo CD can render without GHCR Helm registry
credentials. The operator image is mirrored through `Manual OCI Mirror`, served from the cluster-local registry,
and pinned by OCI index digest in `values.yaml` for both Linux architectures. The application values override
the vendored chart's default image tag.

This release refreshes replica peer addresses after Pod replacement. Each replica's supervisor retains the
existing ledger file, checks the complete DNS peer set every five seconds, and restarts its child only when the
addresses change. Incomplete DNS keeps the current child running. A script checksum updates the StatefulSet
Pod template, and its ten-second minimum ready period gates the managed replica roll.

Rollout order is the reviewed upstream release, verified image mirror, this committed chart/image update,
Argo reconciliation, operator readiness, then the managed ledger StatefulSet roll. Before activating Bayn's
new workers, verify all three ledger replicas are ready and every TigerBeetle process has the current peer
addresses. Confirm exact accounting through Bayn's existing reconciliation owner. Never reformat the ledger
or relax trading authority during rollout. Recovery uses a reviewed Git revert through the same Argo path;
existing persistent volumes, replica identities and ledger files remain in place.
