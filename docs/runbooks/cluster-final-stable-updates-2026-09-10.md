# Final support-service stable updates

The final release audit uses September 10, 2026 at 12:00 UTC as its cutoff.
This wave updates Mimir to 3.2.1, its Nginx gateway to 1.31, Temporal UI to
2.54.0, Cloudflared to 2026.9.0, the Restate operator and CRD charts to 3.0.1,
and both custom NVIDIA device plugins to 0.20.0.

Mimir 3.2.1 updates its Go runtime; it does not introduce another storage
migration. Keep the existing Kafka topic, broker, ingestion partitions, S3
configuration, PVCs and credentials. The native configuration hook validates
every Mimir role with the target binary before the serving workloads update.
The gateway keeps its existing generated Nginx configuration.

The Restate 3.0.1 CRD chart renders the same schemas as 3.0.0. Its operator
reduces redundant introspection requests; registration and draining behavior
remain unchanged. Keep the separate CRD and operator Applications and
`installCrds: false` on the operator.

Both NVIDIA plugin manifests retain their node selectors, security settings,
mounts and resource policies. Altra remains exclusive with one advertised GPU;
Turin retains eight time-sliced allocations. Talos continues to own host
drivers and the container toolkit. Plugin updates must preserve running GPU
consumer identities, including Plex, Flamingo and Saigak.

## Delivery and acceptance

Render the affected application sources, compare their resource identities and
configuration, and validate changed workload manifests against the live API
with server dry run. Review and exact-head CI precede merge. Existing Argo
Applications reconcile the committed desired state.

Require native target versions and ready workloads. Compare a fixed historical
Mimir query captured before the update, then verify newly ingested samples.
Check Temporal UI's workflow and namespace API against the unchanged backend,
Cloudflared's registered tunnel connections, and Restate's existing service
registrations and resource reconciliation. Confirm NVIDIA GPU allocations and
the original consumer Pods after both plugin DaemonSets roll.

## Recovery

Retain the previous image and chart references in Git. If a target fails its
acceptance, revert the affected component through the same GitOps owner.
Preserve storage, Kafka offsets, credentials, tunnel identity, GPU policies and
application configuration. These updates do not require restoring data or
changing Bayn execution authority.

## Release sources

- [Mimir 3.2.1](https://github.com/grafana/mimir/releases/tag/mimir-3.2.1)
- [Temporal UI 2.54.0](https://github.com/temporalio/ui/releases/tag/v2.54.0)
- [Cloudflared 2026.9.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.0)
- [Restate operator 3.0.1](https://github.com/restatedev/restate-operator/releases/tag/v3.0.1)
- [NVIDIA device plugin 0.20.0](https://github.com/NVIDIA/k8s-device-plugin/releases/tag/v0.20.0)
