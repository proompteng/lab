# Relay

Relay is Tengri's Rust connector execution service. The guest's credential-free stdio MCP adapter connects to
`https://relay.relay.svc.cluster.local:8443/mcp` using its rotating SPIFFE identity. Relay owns HTTPS connections and
Bearer credentials for upstream MCP servers. It is not an arbitrary HTTP proxy and does not execute downloaded
connector code inside the guest.

## Current boundary

Relay accepts only `spiffe://proompteng.ai/ns/tengri/nanoagent/pod/<Pod UID>`. Each request checks the live Pod and
its controlling MicroVM, owner UID, current guest UID, desired state, and owner hash. Both discovery and execution
require a grant for that exact owner and agent. Execution checks the current grant again before dispatch, including
after upstream initialization. API errors deny access. Two replicas share authoritative Kubernetes configuration;
there is no SQLite database, local authorization cache, or in-memory-only grant store.

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
`relay-grants` ConfigMap contains `config.json`:

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
cannot read Secret objects through the Kubernetes API.

Tool names exposed to the agent are `<connector ID>__<upstream tool name>`. Grant and credential configuration must
be reviewed and deployed before restarting the guest's MCP connection to discover newly added tools. Removing a
grant takes effect on subsequent calls without restarting a guest, including tools already cached by Codex. A call
already dispatched to a provider cannot be undone. Relay performs no automatic tool-call retries.

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
At that scale, use a transactional external database for connection/grant/audit records and a dedicated encrypted
credential store. Those UI and OAuth flows are not implemented in this first release.

## Validation and delivery

```sh
cargo fmt --manifest-path services/relay/Cargo.toml --check
cargo clippy --manifest-path services/relay/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/relay/Cargo.toml --locked --all-targets
```

Tests exercise the real Kubernetes client against a local API fixture, including owner isolation, stale Pod UIDs,
grant removal immediately before dispatch, ungranted tools, private-network targets, unsupported server requests,
and bounded SSE framing. Nanoagent's adapter tests check correlation IDs, notification handling, and error redaction.

`Relay images` publishes signed amd64/arm64 indexes from reviewed `main`. Its immutable alias is exposed only after
validation, index verification, signature verification, and index artifact retention. Warehouse `relay`, automatic
Stage `relay`, and Application `relay` follow `kargo/relay`. The Stage writes the exact image digest and source revision.
Do not deploy an image from a worktree or bump its digest in a deployment PR. Rollback re-promotes proven Relay Freight.

Roll out Relay and the Tengri read-only identity RBAC/network allowance before activating the new guest image.
Existing running guests retain their current image; use the established owner/idle sleep-resume boundary to adopt
the new adapter without deleting workspace data. Verify actual authenticated MCP calls, denied calls, current image
digests, and SPIFFE renewal in addition to readiness and Argo health.
