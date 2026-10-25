# Keycloak identity service

This is the active GitOps source for the existing Keycloak database, master realm, Headlamp and Agents Shell clients,
and the dedicated [Tengri realm](tengri/README.md). The old prepared Keycloak overlay is removed.

Two Keycloak 26.7.4 servers require separate hosts. They use JDBC cache discovery, transport mTLS, Pod/node topology
names and verified PostgreSQL TLS. Each server has a maximum of twenty SQL connections. The database requires three
host-spread instances, one synchronous standby and a 100-connection budget. Only its Pods tolerate Ryzen's exact
`workload.proompteng.ai/compute-local=true:NoSchedule` taint; the node taint stays in place. The serving disruption
budget retains one replica during eviction.

Each database volume is 20 GiB. Replication slots have a 4 GiB WAL budget, so a stale standby cannot retain
an unlimited transaction log on the primary. Keep the slot budget below one quarter of the volume capacity.
If a standby falls behind that budget and its required WAL is absent from the archive, rebuild that standby from
the healthy primary. Never remove WAL files manually. Expand storage through this Cluster manifest when recovering
a full volume; CloudNativePG resizes the existing PVCs through the storage class.
During an existing full-disk outage, its safety check can stop before automatic PVC resizing. After the Cluster
change merges and syncs, expand the affected PVC to that same reviewed size following the
[full-storage recovery procedure](https://cloudnative-pg.io/docs/1.28/troubleshooting/#storage-is-full).
Verify free space on the mounted filesystem before PostgreSQL restarts.

The existing DNS-01 `letsencrypt-prod` issuer provides the certificate for `auth.proompteng.ai`. Traefik exposes only
HTTPS. The exact Cloudflare tunnel route verifies the origin certificate with that hostname before the wildcard route.
The generated tunnel ConfigMap changes its Pod reference whenever configuration changes.

The server NetworkPolicy permits HTTP from Traefik and the existing bootstrap jobs. Cache ports are restricted to
Keycloak servers. Database traffic remains private, and external HTTPS egress excludes private and reserved networks.
The Tengri bootstrap uses strict sealed credentials in an earlier Argo wave, verifies the realm before enabling it,
and preserves users, broker links and passkeys on retries. A new protected `keycloak-server-26-7-4` snapshot must
complete before the upgrade wave. The existing Argo Backup health check waits for the CNPG completion timestamp;
older protected backup objects and their snapshots remain retained.

Render and verify the active source with:

```sh
kustomize build argocd/applications/keycloak
bash services/ofz/test-ha-manifests.sh
bash services/ofz/test-control.sh identity
```

The real two-server fixture proves failover during a passkey challenge with production Keycloak and PostgreSQL TLS.
It uses synthetic GitHub identities and virtual passkeys. Independent backups and restore, Kubernetes host loss,
the real OAuth callback switch and both custodians' passkey enrollment still require deployment evidence.
