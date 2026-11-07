# Tengri Ofz runtime

This active Kargo-managed application uses the central Ofz authority. The prepared overlay and legacy direct SpiceDB
key, shared runtime credential and ConfigMap nonce state are removed. Two controllers run on separate hosts; only
the fenced SQL leader reconciles slots. Rolling updates replace one controller at a time and keep one available,
so required host anti-affinity does not require a third host with spare capacity. The namespace budget covers six slots
and two controllers.

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

## Private run reader

The same Tengri image runs `run-reader` in the existing Restate namespace. This isolates the fixed state-query routes
from the admin API: controllers can call only `/status` and `/active` over strict mesh mTLS, and only the reader can
reach admin port 9070. It has no Kubernetes API permissions, mounted token or application secrets. The namespace
transformer defaults ordinary resources to Tengri while preserving this explicit Restate namespace; no Namespace is
rendered or created by this application.

Rollout order: enroll the reader's dedicated SPIRE proxy identity, publish the immutable paired images, then let
Kargo promote the Tengri release. Argo installs reader policy and Service in wave -2, waits for reader readiness in
wave -1, updates controllers in wave 0, and registers the worker in wave 1. Preserve old workers while accepted runs
remain pinned to them. The removed public `status` and `active` handlers have no compatibility path. No run-state,
home-volume or database migration is needed. The CNI preflight hash converges after the promoted controller policy.

If the reader cannot query state, reads fail closed and execution remains durable. Correct the reader release through
the same promotion path; never replay accepted input, edit snapshots to fabricate completion, expose the admin API
to controllers, or replace the retained home to make a status check pass.
