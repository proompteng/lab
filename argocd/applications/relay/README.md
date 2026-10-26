# Relay deployment

This application deploys the platform executor through the `relay` Kargo Warehouse and Stage to `kargo/relay`.
ApplicationSet owns creation of namespace `relay`. Manifests deliberately use explicit namespaces because the
read-only Kubernetes Roles/RoleBindings belong to the three enrolled target namespaces.

`config.json` records the actual cluster endpoint and immutable namespace UIDs, read from Galactic on 2026-10-25.
Changing or recreating a namespace requires reviewed configuration, RBAC and Ofz policy enrollment. The executor
has only pod/event reads, bounded pod-log reads and exact namespace-identity reads. Its rotating projected token and
cluster CA remain inside Relay. OpenCode and Tengri receive operation results and policy receipts.

Ofz, SPIRE registrations and network paths must be ready before Relay accepts clients. The Ofz post-sync policy
onboarding hook installs the reviewed package as the migration owner. The first release is a hard protocol cutover;
follow [the platform guide](../../../docs/platform/ofz-relay.md) and normal immutable image/Kargo gates.

No namespace grants are assigned automatically by this application. A platform administrator assigns the declared
native relationships through Ofz. Production acceptance must exercise both clients, allowed and denied targets,
revocation, native cluster RBAC failures and durable receipts against the deployed image/revision.
