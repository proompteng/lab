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

## Google project metadata

`google-project__read` reads only `projects/952507162578` using Relay's SPIRE identity and Google token exchange.
The operation accepts an empty object. Its HTTPS destination, project, audience and scope are fixed in `config.json`.
Ofz registers `google.project.read` on resource `google.project/952507162578` in the Proompteng workspace.
Enrollment grants no caller access. A workspace administrator assigns `reader` to the exact approved human or
workload through the existing admin portal. The Google IAM binding separately authorizes Relay's machine identity.

Release the matching Ofz policy package and Relay configuration through their normal Kargo stages. Before assigning
access, confirm the operation is absent from the client's discovered tools. After assigning access, invoke it through
the deployed client's normal MCP bridge:

```sh
kubectl --context galactic-tailscale -n opencode exec -i deployment/opencode -c opencode -- relay-client <<'JSON'
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"google-project__read","arguments":{}}}
JSON
```

Require the Google project response and `_meta.relay` authorization/execution receipt IDs. Confirm the execution
in the workspace activity log. Revoke access and repeat discovery and invocation to verify denial, then restore only
the approved grant. Caller arguments must not select another project or endpoint. Kubernetes tools must continue
to work with their existing grants. Recovery is a normal Git revert/promotion and revocation of the new reader grant;
retain the independent Google trust configuration and existing workspace permissions.
