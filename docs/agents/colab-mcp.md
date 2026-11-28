# Colab MCP for AgentRuns

The standard `codex` and `google` AgentProviders start `colab-mcp-bridge` as a stdio MCP server named
`colab`. The bridge reads the Pod's rotating `agents.proompteng.ai/colab-mcp` token at
`/var/run/secrets/agents-colab-mcp/token`. The gateway uses TokenReview and checks the Pod, Job, active
AgentRun, Agent, and AgentProvider before forwarding requests to the
[hosted Colab MCP server](https://developers.google.com/colab/api/reference/mcp).

## Activation

1. Enable the Colab API and hosted MCP access for the quota project (`proompteng`). Use a Google user
   dedicated to this gateway, with a Colab entitlement and permission to use that quota project.
2. Store that user's authorized-user ADC JSON in the 1Password item `colab-mcp-adc`, field `credentials.json`.
   The ExternalSecret mounts it only on the gateway. Do not reuse `google-adc-auth`, which remains the
   Google provider's model sign-in. AgentRuns never receive the gateway's ADC or OAuth access token.
3. Promote the controller and runner images together through the normal Agents release path. The
   controller must recognize the additional token projection, and the runner must contain the bridge.

`/healthz` remains healthy without credentials so the Service can return
`colab_credentials_unavailable` on a tool call. `/readyz` returns 503 until it can parse the mounted
ADC file; it does not exchange a token on each probe. The optional volume allows 1Password provisioning
and rotation without a gateway restart. The audit record contains the verified run identity, tool,
status, and duration, not requests, results, or credentials.

## Runtime cap and network scope

Use `list_runtimes` before creating a runtime. Use separate sessions for isolated kernels and clean up
unused sessions and runtimes. The five-runtime limit applies to the shared Colab identity, not to each
AgentRun. The gateway counts listed runtimes and creations not yet visible to Colab's list endpoint.
If creation is unconfirmed, check `list_runtimes` before retrying. A reservation is released after the
runtime is observed, a deletion is confirmed, or Google definitively rejects the create.

Run one replica with the `Recreate` strategy. Reservations are in memory; reconcile outstanding
creations with Colab after an unclean restart. Do not share the gateway's Google identity with other
runtime creators. The cap cannot coordinate with writers outside this process.

Kube-router NetworkPolicy matches ports and selectors, not Google hostnames. The gateway pins the
Google OAuth and Colab HTTPS endpoints and rejects redirects. The existing Agents rollout allow-all
policy remains in place; TokenReview and owner checks enforce access regardless of that policy.
