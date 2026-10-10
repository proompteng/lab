# Ofz control-plane cutover resources

This directory is intentionally not included by the parent kustomization until the coordinated P8 release.
The existing production graph and credential consumers remain the authority during implementation.

The cutover must supply reviewed immutable images through Kargo, managed database roles and sealed credentials,
the exact Ofz SPIFFE registration, a migrated graph/control database, the independent audit exporter, and the Tengri
Keycloak realm. Add TLS for `auth.proompteng.ai` at the existing Traefik ingress before opening new sessions.
The Ofz client connects to that reviewed internal ingress address while verifying the original HTTPS hostname.

Use a separate `ofz_migrator` owner for `ofz_control`. The API logs in as `ofz_api` and the independent exporter as
`ofz_archiver`. `tengri_control` belongs to `tengri_migrator`, with separate BFF/controller application roles.
The API's twelve pooled plus two command connections per replica need a role limit of at least 28 across two replicas.
Keep the combined SpiceDB, Ofz, BFF, controller, exporter and migration budget below PostgreSQL's 200 connections.

Run the initial migration as its short-lived owner with `ofz migrate`. Rerunning the same migration is idempotent;
a checksum mismatch fails. The API verifies the schema checksum at startup and begins with the platform fenced.
Run `ofz migrate-runtime` separately using the existing `OFZ_DATABASE_*` mounted TLS credential settings for
`dbname=tengri_control user=tengri_migrator`. This commits the runtime schema and version checksum atomically;
repeat the command before admission to verify idempotency. Application roles cannot run this migration.
Only the API and reviewed migration jobs may mount the native SpiceDB key after cutover.

Render this directory separately during preparation; it contains no Namespace. NetworkPolicy limits the API to its
four caller classes, DNS, Ofz PostgreSQL/SpiceDB, and the existing TLS ingress. SPIFFE mTLS independently checks exact
caller identities. TCP probes establish listener availability; use real authorization probes for dependency health.
