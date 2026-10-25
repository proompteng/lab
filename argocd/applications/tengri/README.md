# Tengri Ofz runtime

This active Kargo-managed application uses the central Ofz authority. The prepared overlay and legacy direct SpiceDB
key, shared runtime credential and ConfigMap nonce state are removed. Two controllers run on separate hosts; only
the fenced SQL leader reconciles slots. The namespace budget covers six slots, two controllers and one rolling surge.

The controller reads its dedicated `tengri_controller` database password, the shared BFF request key and a private
32-byte Ed25519 guest signing seed. Supervisors use the separate `tengri_supervisor` role and receive only the public
verification key. Both key bundles carry recovery generation `1`, matching the fresh Ofz platform. Only the controller
mounts the signing seed. Recovery rotates the key and advances the generation before admitting any restored writer.

The existing External Secrets operator projects only `ofz-db-ca`'s public `ca.crt` into `ofz-database-ca`. Its reader
can get that one Secret and cannot list Secrets or read another Secret. The ClusterSecretStore accepts only the Tengri
and Proompteng namespaces. No CA private key is copied into an application Secret. The controller and supervisors
load their verified PostgreSQL TLS roots at startup; include their restart in a coordinated database CA rotation after
verifying the projected public bundle. The BFF reloads its connection pool when the mounted bundle changes.

Existing workspaces and homes were deleted with explicit authorization. There is no retained-data importer or old
authorization implementation. Keep `tengri-ofz-cutover` until the reviewed identity, Ofz activation, controller and guest
images are installed. Remove its policy and binding only after the exact contracts are verified, then create fresh
workspaces through the authenticated app. Verify files, terminal, Codex and sleep/resume before declaring rollout complete.

Validate the active contracts with:

```sh
bash services/ofz/test-ha-manifests.sh
bun test packages/scripts/src/tengri/gitops-contract.test.ts
```
