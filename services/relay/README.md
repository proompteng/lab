# Relay

Relay is Tengri's Rust connector execution service. The guest's credential-free stdio MCP adapter connects to
`https://relay.relay.svc.cluster.local:8443/mcp` using its rotating SPIFFE identity. Relay owns HTTPS connections and
Bearer credentials for upstream MCP servers. It is not an arbitrary HTTP proxy and does not execute downloaded
connector code inside the guest.

## Current boundary

Relay accepts only `spiffe://proompteng.ai/ns/tengri/nanoagent/pod/<Pod UID>`. Each request checks the live Pod and
its controlling MicroVM, owner UID, current guest UID, desired state, and owner hash. Both discovery and execution
require SpiceDB permission for that exact owner, MicroVM creation UID, connector, and tool. Execution checks the
current permission again before dispatch, including after upstream initialization. Every check requests fully
consistent data. Denied, conditional, malformed, and unavailable decisions fail closed. Two replicas use the shared
Ofz SpiceDB service, backed by external PostgreSQL; there is no local authorization cache or grant database.
Discovery uses bulk permission checks in batches of 256, with at most four requests in flight and one authorization
credential read per discovery request. Initialization and ping validate the live guest without scanning catalog
tools. Execution checks only the selected tool and revalidates its metadata and permission before dispatch.
Nanoagent registers Relay as an optional MCP server so backend provisioning or downtime does not block conversations;
connector operations remain unavailable until Relay initializes and has durable permission grants.

This initial release supports explicitly granted read-only HTTPS MCP tools, JSON and bounded SSE responses, and
optional Bearer credentials. Write tools, server-initiated sampling/elicitation, executable connectors, and OAuth
onboarding are unsupported and rejected. `readOnly` is an operator assertion about the selected provider tool;
Relay cannot prove that a remote provider implements it without side effects. Never grant a write tool as read-only.

The existing guest Internet/model/bootstrap access policy remains in place. Relay isolates connector credentials
and its execution path; it does **not** yet provide network-wide prevention of guest bypass. Removing broad guest
egress requires a separate model/bootstrap route, and removing model credentials requires moving account login
and inference authorization outside the guest. Do not describe this release as a completely secretless or offline agent.

## Enable a connector

Configuration is operator-managed through GitOps for this release. No connector is enabled by default. The
`relay-catalog` ConfigMap contains endpoint, credential-reference, and reviewed tool metadata in `config.json`.
Adding a catalog entry does not grant access:

```json
{
  "connectors": [
    {
      "id": "github",
      "ownerHash": "<full MicroVM spec.ownerHash>",
      "agentId": "<MicroVM name>",
      "endpoint": "https://api.githubcopilot.com/mcp/",
      "credentialKey": "github-owner-token",
      "tools": [
        {
          "name": "get_me",
          "description": "Read the connected GitHub account profile",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
          "readOnly": true
        }
      ]
    }
  ]
}
```

Use the provider's current tool names and schemas. The example is configuration shape, not an automatically granted
account. Seal the token into a `relay-credentials` Secret in namespace `relay`, with a key matching `credentialKey`.
Never commit plaintext tokens, mount this Secret into a guest, or copy a token into Codex MCP configuration. Public
servers use `credentialKey: null`. Credentials are read from the projected Secret for each upstream session so
rotation is picked up without restarting the service. Only the Relay Pods mount the Secret; the service account
cannot read connector Secret objects through the Kubernetes API. Its backend-only Ofz Role can get the single
`ofz-spicedb-key` Secret to authenticate permission checks. That key grants access to the shared SpiceDB API, so
Relay is a trusted backend service; the guest never receives it. Ofz currently uses HTTP inside the cluster.
Relay's NetworkPolicy permits only the Ofz SpiceDB Pods on port 8443 for this connection.

### Zanzibar authorization

Install the reviewed `schema.zed` using `install-schema.py --endpoint http://127.0.0.1:18443 --apply` with an
Ofz Service port-forward and `OFZ_TEST_TOKEN` supplied privately. The installer is idempotent and refuses to
replace a different application schema. Future shared schemas require an additive reviewed migration.
No owner, agent, connector, or tool grant is created by installation or service startup.

Trusted control-plane services manage these relationships through Ofz; agents cannot write them:

- `relay_agent:<MicroVM metadata.uid>#owner@relay_user:<ownerHash>`
- `relay_connector:<agent UID>/<hex connector ID>#owner@relay_user:<ownerHash>`
- `relay_connector:<agent UID>/<hex connector ID>#agent@relay_agent:<agent UID>`
- `relay_tool:<agent UID>/<hex connector ID>/<hex tool name>#connector@relay_connector:<agent UID>/<hex connector ID>`
- `relay_tool:<agent UID>/<hex connector ID>/<hex tool name>#agent@relay_agent:<agent UID>`

Hex encoding uses lowercase UTF-8 bytes, without a prefix. It prevents delimiter collisions and supports provider
tool names containing dots. A tool's `execute` permission requires both connector ownership and an agent grant.
Deleting an owner, connector-agent, or tool-agent relationship revokes subsequent calls. Recreating an agent uses
a new creation UID and receives no old grants. A restarted guest Pod retains its logical agent's permissions.
The endpoint and credential remain catalog metadata; SpiceDB is authoritative for permission decisions.

Tool names exposed to the agent are `<connector ID>__<upstream tool name>`. Grant and credential configuration must
be reviewed and deployed before restarting the guest's MCP connection to discover newly added tools. Removing a
SpiceDB relationship takes effect on subsequent calls without restarting a guest, including tools already cached
by Codex. A call already dispatched to a provider cannot be undone. Relay performs no automatic tool-call retries.

Endpoints must use HTTPS on port 443, with a public DNS name and no userinfo or fragment. Relay rejects mixed
private/public DNS answers and pins the checked IPv4 addresses for the session. IPv6 upstreams, redirects, ambient
HTTP proxies, arbitrary destinations supplied in a tool call, and cluster/metadata addresses are rejected.
Requests are limited to 1 MiB, responses to 2 MiB, calls to 60 seconds, and service concurrency to 32 calls per replica.
Provider error bodies, arguments, tokens, and response content are not logged. A result containing the literal
Bearer credential is rejected. Providers remain trusted recipients of their credentials; this check cannot detect
every transformation a malicious provider could make.

## Self-service onboarding design

The next layer belongs in Tengri's authenticated desktop and control plane: a connector catalog, browser OAuth
authorization and callback with owner-bound state and PKCE, server-side token exchange/refresh, tool discovery,
per-agent tool grants, connection health, call audit, and disconnect/revocation. One account connection should be
reusable across selected agents through independent grants. Custom HTTPS MCP endpoints use the same authorization
and endpoint checks. Provider adapters hold OAuth metadata and authentication details, not separate guest plugins.
Connection and audit records need a transactional external database and a dedicated encrypted credential store;
permissions remain SpiceDB relationships. Those UI and OAuth flows are not implemented in this first release.

## Validation and delivery

```sh
cargo fmt --manifest-path services/relay/Cargo.toml --check
cargo clippy --manifest-path services/relay/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/relay/Cargo.toml --locked --all-targets
```

Tests exercise the real Kubernetes client against a local API fixture, including owner isolation, stale Pod UIDs,
catalog removal and SpiceDB revocation immediately before dispatch, denied permissions, authorization outages,
argument schema constraints, ungranted tools, private-network targets, unsupported server requests,
and bounded SSE framing. Nanoagent's adapter tests check correlation IDs, notification handling, and error redaction.

`Relay images` publishes signed amd64/arm64 indexes from reviewed `main`. Its immutable alias is exposed only after
validation, index verification, signature verification, and index artifact retention. Warehouse `relay`, automatic
Stage `relay`, and Application `relay` follow `kargo/relay`. The Stage writes the exact image digest and source revision.
Do not deploy an image from a worktree or bump its digest in a deployment PR. Rollback re-promotes proven Relay Freight.

Roll out Relay and the Tengri read-only identity RBAC/network allowance before activating the new guest image.
Existing running guests retain their current image; use the established owner/idle sleep-resume boundary to adopt
the new adapter without deleting workspace data. Verify actual authenticated MCP calls, denied calls, current image
digests, and SPIFFE renewal in addition to readiness and Argo health.
