# Fenced Ofz control plane

The active Ofz application includes this directory. Kargo selects one successful immutable Ofz image and applies
its digest to the API, exporter, both migration jobs, bootstrap and activation. The application tracks `kargo/ofz`; the selected image's
source revision, digest and build run are recorded on the rendered resources.

CNPG manages seven separate login roles with namespace-bound SealedSecrets. The short-lived `ofz_migrator` and
`tengri_migrator` owners initialize their respective databases through Sync hooks before the serving deployments.
The next hook runs `ofz bootstrap` with the protected approved administrator manifest and retains the platform fence.
Every outer SealedSecret is in wave -9, before the database and native consumers. Network policies are in wave -5,
before the migration hooks in -4 and bootstrap in -3. The PostSync activation hook uses the same protected manifest
and its distinct activation operation ID. It requires the real archive checkpoint and exact native relationships.
Retries return the original receipt and cannot lift a later recovery or offboarding fence. Keep Ofz reconciliation
held until the independent database restores, real identity configuration and selected controller/guest images are ready.
The API uses `ofz_api`; only `ofz_archiver` can acknowledge audit exports. BFF, controller and supervisor roles have
separate credentials and table grants. None of these roles can create roles or databases, replicate, bypass RLS or
act as superuser. The fixed connection limits cover simultaneous serving surges and preserve the existing SQL budget.

The namespace-local `ofz-ca-source` SecretStore publishes only `ca.crt` into `ofz-db-public-ca` through the existing
External Secrets controller. The shared `ofz-database-ca` ClusterSecretStore can read only that public bundle and serves
only Tengri and the BFF namespaces. It cannot read the CNPG Secret containing `ca.key`. Ofz database callers project
only `ca.crt` into their mounts. Certificate refresh uses the existing one-minute reconciliation intervals.

SpiceDB's qualified read/write pool limits and disabled dispatch caches now live in the active application.
The obsolete prepared Ofz overlay is removed. `bash services/ofz/test-ha-manifests.sh` renders this source alongside
the active Tengri, BFF and Keycloak targets and checks their shared contracts. The prepared application overlays are removed.

The API requires the exact `spiffe://proompteng.ai/ns/ofz/sa/ofz-api` registration. Its namespace, Pod label, service
account and container selectors are explicit in the SPIRE configuration. API network access remains restricted to
reviewed callers, the control database, native SpiceDB and the existing TLS identity ingress. TCP probes establish
listener availability; real authorization checks establish policy behavior.

Two exporter replicas share the existing PostgreSQL session lease. The rolling strategy starts no extra replica,
keeping the active connection and standby leases within the archive role's four-connection limit. Exporter Pods mount
only their database credential, database CA and NUC writer credential. NetworkPolicy allows DNS, PostgreSQL and
`100.78.240.108:9444`. Native policy and NUC custodian credentials are absent.

The API initially serves with the SQL platform fence set. Deploy the independent NUC archive first and verify its
private TLS endpoint from another peer, then verify actual Kubernetes exports and acknowledgements. The reviewed
owner bootstrap hook uses the protected approved manifest. Activate only after identity, audit and coordinated runtime
checks pass. Keep the Kubernetes workspace-creation fence until the final controller/guest release is installed.
The dedicated Keycloak realm and the valid `auth.proompteng.ai` certificate are required before opening sessions.

On a failed migration, the checksum rejects an incompatible binary and the Sync hook prevents the API rollout.
Restore the reviewed image through Kargo. Retain both control databases, their roles, SealedSecrets and the independent
archive; never fabricate an archive acknowledgement to proceed. Schema checksum and live fence readback are required
before continuing a cutover.
