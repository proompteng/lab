# Relay platform executor

Relay executes registered connector operations after Ofz authorizes their exact resources. Tengri and standalone
OpenCode use the same protobuf execution contract. They have separate identities and authority.

The first adapter is Kubernetes: pod status, bounded pod logs, and namespace events. These operations execute against
the configured cluster API using Relay's projected service-account credential. Pod status omits pod specifications and
inline environment values. Logs are plain text. The client cannot supply a URL, credential, HTTP method, exec command,
watch, or arbitrary Kubernetes path. Kubernetes mutations remain unregistered.

Registered HTTP, CLI and upstream MCP adapters use the same authorization, discovery and receipt path. Each operation binds one
fixed resource, a catalog action and a reviewed JSON input schema. Its target is derived from the registration;
arguments cannot select another account, destination or command. CLI and HTTP adapters support approved read operations. Authenticated MCP endpoints can also enroll mutations using the invocation contract below.
An HTTP POST may represent a read, such as a search; the operator must verify the provider operation before enrollment.
Registering a transport does not grant resource access or introduce a policy definition into Ofz.

Tool discovery uses the same Ofz identity and resource permissions as execution. `ListOperations` requires the
current human session or the caller's attested workload identity. Relay asks Ofz for approved workspace/resource/action
scopes before building each adapter's tool schemas. An unapproved namespace appears in neither targets nor schema
values. An empty catalog is a valid result; it does not imply a cluster or provider failure.

[`relay.proto`](../../proto/proompteng/relay/v1/relay.proto) defines the public API.
[`platform.proto`](../../proto/proompteng/authz/v1/platform.proto) defines Ofz authorization, policy management,
delegation and execution receipts. See [the platform guide](../../docs/platform/ofz-relay.md) for onboarding and cutover.

## Execution

1. Authenticate the caller with an exact SPIFFE identity from Ofz's approved service registry.
2. Parse the bounded execution body, validate its client and subject, and normalize the adapter arguments once.
3. Authorize the normalized resources and SHA-256 of the exact submitted body through Ofz.
4. Record a durable execution start, recheck authority, then execute the normalized request.
5. Recheck authority before disclosing the result. Commit the outcome and check again after its audit commit.

Namespace policy uses `kubernetes.namespace` and `<connector-id>/<namespace-uid>`. Relay checks the live namespace UID
before and after the API operation. A namespace recreation requires reviewed re-enrollment. Status/events return at
most 100 items; logs default to 100 lines and allow at most 500 lines and 262,144 bytes. Responses have a byte limit and
requests have a deadline. Kubernetes RBAC and network policy independently bound the executor's authority.

Ofz records started, succeeded, failed and withheld outcomes. Transport errors and Kubernetes RBAC errors cannot
become successful results. The immutable audit contains request/result digests and policy receipts, without credentials
or returned log bodies. Reusing an execution ID cannot issue a second cluster request. An interrupted start remains
visible; callers must not treat it as confirmed completion.

The durable start is an exclusive claim across Relay replicas. Even an identical start retry is rejected; only the
transaction that first creates the execution may dispatch it. Terminal outcome retries return their original receipt.

`GetExecution` observes that claim without dispatching a provider request. The client submits an `ExecutionLookup`
envelope containing the exact original execution body, its current binding and its current delegation ID. A delegated
client signs the lookup envelope with a fresh proof. Execution and lookup bodies are distinct, so a proof for one
cannot authorize the other. Ofz checks current permission before and after reading the receipt. Lookup also requires
the original client, owner, resources and request hash. Renewed credentials can observe their issuer's earlier
execution; another workload or issuer cannot. Expired or revoked authority cannot read the snapshot.

The snapshot contains the original authorization receipt, latest execution receipt, outcome, timestamps, provider
status and digests. It does not contain the result. `started` means completion remains unconfirmed. Status lookup
cannot turn an uncertain outcome into a successful tool response or recover a lost result body.

Ofz supplies Relay's enrolled clients. Relay refreshes that roster every two seconds, clears it on a failed refresh,
and rejects a roster older than ten seconds. The same roster guards TLS handshakes and every RPC, including existing
connections. Adding a client requires no second identity allowlist in Relay.

## Clients

`packages/platform-client` supplies Rust protobuf types, exact-peer SPIFFE TLS and the shared execution body.
The `relay-client` binary is an MCP stdio bridge for independent workloads such as OpenCode. Each operation asserts
that workload's registered identity; it contains no Tengri workspace or human session.

`tools/list` follows the negotiated MCP `2025-03-26` cursor protocol. Tools are ordered lexicographically by their
`connector__operation` name, with at most 50 tools per response. Pass the returned `nextCursor` as `params.cursor`
to continue; final and empty pages omit `nextCursor`. Clients must treat the bounded cursor as opaque and must not
persist it across sessions. Malformed, out-of-range or stale cursors return JSON-RPC `-32602` (invalid params);
restart without a cursor after a catalog change.

Every page refreshes authorized `ListOperations` discovery. Cursors bind the position to the full authorized catalog,
including descriptions, schemas, annotations, actions and resource targets, so a permission or registration change
invalidates continuation even when tool names and counts stay the same. No cached page can disclose removed tools.
Discovery denial or unavailability fails closed with the existing server error. Listing never dispatches `Execute`,
looks up an execution or invokes a provider operation; the existing transport message budgets still apply.

Successful tool responses include operation and receipt IDs in `_meta.relay`. After a failed call or an unusable
response, the bridge performs one authorized status lookup with the retained original body, including for
Kubernetes RBAC and missing-resource failures. It never resends Execute. The MCP response remains an error because the
original result is unavailable, and includes the confirmed outcome or `unknown` if lookup is denied or unavailable.

The Tengri BFF installs a proof-bound delegation into the current guest. Ofz creates it inactive. The BFF activates it
only after the guest acknowledges its exact delegation ID and proof-key thumbprint. Ofz checks the issuer's current
permission, membership, workspace ownership, running generation, grant expiry and recovery generation on every call.
DPoP binds the credential, key, destination, method and exact body, and each proof nonce can be consumed only once.

## Configuration and validation

`RELAY_CONFIG_FILE` names a strict JSON connector definition; `OFZ_GRPC_TARGET` names the Ofz DNS authority.
`SPIFFE_ENDPOINT_SOCKET` supplies the workload API. Cluster endpoint, CA file, projected token file and immutable
namespace identities are operator configuration. Tokens are read for every invocation so projection rotation works.

An HTTP registration fixes an HTTPS origin and each operation's path and `GET` or `POST` method. GET arguments become
encoded scalar query values; POST arguments become JSON. Redirects, environment proxies and automatic request retries
are disabled. The deadline is ten seconds and responses are limited to 256 KiB, including streamed bodies. Optional
`ca_file` is an optional absolute mounted path; omitting it uses the platform trust store. Required `authentication`
is `{ "type": "none" }`, `{ "type": "bearer_file", "path": "/mounted/token" }`, or
`{ "type": "oauth2", "profile": "inventory" }`. Provider authentication failures remain distinct from Ofz denials.
OAuth profiles and destinations must match Ofz registrations at startup and every enrollment refresh.

### Workload identity federation

HTTP and HTTP MCP registrations also accept `workload_identity`. Relay obtains a JWT-SVID from its local
SPIRE Workload API, verifies the exact registered subject and audience plus expiry, asks the agent to validate
it, and exchanges it for a bearer access token using [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html).
The token service must support JWT subject tokens, the registered audience and scopes, and return an access token
with `issued_token_type`, `token_type: Bearer`, and `expires_in` between 1 and 86,400 seconds.

```json
{
  "type": "workload_identity",
  "federation": {
    "spiffe_id": "spiffe://proompteng.ai/ns/relay/sa/relay",
    "audience": "//iam.googleapis.com/projects/952507162578/locations/global/workloadIdentityPools/proompteng-ai/providers/spire",
    "token_endpoint": "https://sts.googleapis.com/v1/token",
    "scopes": ["https://www.googleapis.com/auth/cloud-platform.read-only"]
  }
}
```

This registration uses the same value for the JWT audience and the token-exchange audience. The issuer is
`https://oidc.proompteng.ai`. The Google pool `proompteng-ai` uses one provider, `spire`, with that exact issuer and
audience, `google.subject = assertion.sub`, and `assertion.sub.startsWith('spiffe://proompteng.ai/')` as its admission
condition. Pool admission authenticates identities from our trust domain. Grant resource permissions to each workload's
exact SPIFFE subject; do not grant roles to the whole pool. This follows
[Google's WIF guidance](https://docs.cloud.google.com/iam/docs/best-practices-for-using-workload-identity-federation)
on sharing a provider while keeping authorization specific to external identities.
For the Google test project `lab-wif-test-20261105`, the intended proof is a custom role containing only
`resourcemanager.projects.get`, then an authorized HTTP GET to
`https://cloudresourcemanager.googleapis.com/v3/projects/952507162578`.
[Google's STS contract](https://docs.cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token) defines the
exchange; [Resource Manager calls are free](https://cloud.google.com/resource-manager/pricing).
Creating a Google project alone does not configure its pool, provider, permission binding or Relay operation.

The connector owns its fixed destination, federation registration, operation paths and Ofz resource/action mappings.
Callers cannot supply any of these in tool arguments. Federation runs only after the existing Ofz authorization and
durable execution start. It represents Relay's machine identity; it does not replace per-user OAuth accounts or grant
the calling human/workload any Ofz permission. Register and authorize the corresponding Ofz operation before enabling
the connector, and permit its token and resource hosts in deployment egress policy.

Access tokens are held only in memory, separately for each connector. Concurrent requests share one successful
refresh. Renewal starts 10% before expiry, capped at 30 seconds, using a newly fetched JWT. Failed renewal fails the
operation; no expired cached token is used. A provider denial does not replay the resource request. JWT acquisition
has a five-second deadline; the entire exchange, including cache-lock wait, has a ten-second deadline and a 32 KiB
response budget. Redirects, environment proxies and automatic retries are disabled. Provider response bodies and
tokens are never included in errors. Optional federation `ca_file` is an absolute CA path independent of the resource
server's CA; production Google registrations use the system trust store.

The isolated test in `test-client.sh` uses real Unix-socket Workload API RPCs, signed JWTs, HTTPS OIDC discovery/JWKS,
token exchange and both actual adapters. It checks concurrent refresh, signing-key rotation, expiry, wrong
subject/audience/issuer/signature, provider denial, redirect/lost responses and malformed credentials. It does not
establish that Google trust or production Ofz grants have been enrolled; those require separate live proof.

For example, after enrolling `inventory.account` and `inventory.items.read` in Ofz:

```json
{
  "version": 1,
  "connectors": [
    {
      "type": "http",
      "id": "inventory",
      "endpoint": "https://inventory.example.com/",
      "authentication": { "type": "bearer_file", "path": "/var/run/inventory/token" },
      "operations": [
        {
          "operation": {
            "name": "items",
            "description": "Search the approved inventory account",
            "action": "inventory.items.read",
            "target": { "name": "Team inventory", "kind": "inventory.account", "id": "inventory/team" },
            "read_only": true,
            "input_schema": {
              "type": "object",
              "properties": { "query": { "type": "string", "maxLength": 128 } },
              "required": ["query"],
              "additionalProperties": false
            }
          },
          "method": "GET",
          "path": "/items"
        }
      ]
    }
  ]
}
```

A CLI connector uses `type: "cli"`, an `id` and `operations`. Each entry contains the same `operation` definition
and a `process` with an absolute `program`, fixed `arguments`, and an absolute working `directory`. Optional `environment` values and
`secret_files` map environment names to fixed values or absolute projected-file paths. The process inherits no
ambient environment. Arguments arrive as validated JSON on stdin; they are never interpolated into a shell command
or argv. Stdout must be JSON. Stdout and stderr each have a 256 KiB limit; stderr and raw process errors are not
returned. Cancellation, output overflow and the ten-second deadline terminate the process group. Programs are trusted,
operator-installed code, not a sandbox for uploaded commands; include their binaries and dependencies in the reviewed
image. Credentials are reread for every invocation.

An upstream MCP connector uses `type: "mcp"`, an `id`, a `transport` and `operations`. Each operation maps the reviewed
`operation` definition to its fixed upstream `tool` name. It does not expose arbitrary discovered tools.

- HTTP transport uses `{ "type": "http", "endpoint": "https://provider.example.com/mcp", "authentication": { "type": "none" } }`,
  with optional `ca_file` and the same required authentication choices as HTTP connectors. It supports JSON and SSE responses with verified TLS and bounded bodies.
- Stdio transport uses `{ "type": "stdio", "process": { ... } }`, with the same fixed process profile, cleared
  environment, projected credentials and process-group lifetime as CLI operations. Provider stderr is discarded.

The maintained MCP SDK owns protocol negotiation, message correlation and tool calls. Registration requires
an explicit `read_only` flag. Relay checks the upstream tool's exact input schema before dispatch. Reads reject
explicit effectful or destructive hints. Writes require `readOnlyHint: false`, authenticated HTTPS and
`relay_context: true`. Relay passes its authorized operation ID, client, actor, action, resources and authorization
receipt in `_meta["io.proompteng.relay"]`; user arguments cannot supply or replace it. The provider must authenticate
Relay and durably reconcile this operation ID without replaying side effects. Optional MCP annotations do not grant authority. A changed or missing tool
requires reviewing the registration; provider descriptions and instructions cannot replace the approved catalog. An MCP tool error
is returned as an error; writes remain unconfirmed when no outcome can be established. The complete invocation has a ten-second deadline, and JSON messages, HTTP bodies and
SSE streams have a 256 KiB limit. Automatic session reinitialization, SSE reconnection, redirects and HTTP retries
are disabled. A lost reply or expired provider session cannot repeat a tool call. Provider credentials are reread
for each invocation. OAuth credentials come from Ofz after an authorized execution starts, and never enter the client
configuration or tool arguments. See [Ofz provider onboarding](../ofz/README.md#provider-accounts) for account lifecycle.

Input schemas must describe an object with `additionalProperties: false`. External network and filesystem schema
retrievers are disabled. Discovery omits each unapproved operation and its resource name and schema.

```sh
cargo fmt --manifest-path services/relay/Cargo.toml --check
cargo clippy --manifest-path services/relay/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/relay/Cargo.toml --locked --all-targets
cargo test --manifest-path services/relay/Cargo.toml --locked -p platform-client
bash services/ofz/qualify-platform.sh
bash services/ofz/test-control.sh platform
bash services/relay/test-client.sh
```

The integration fixture uses real PostgreSQL and SpiceDB plus an isolated TLS Kubernetes API. It adds a third client
and policy through fixture definitions, and executes actual HTTP, CLI and upstream MCP adapters with the same authority and receipt
checks. Driver tests cover TLS, argument injection, credential rotation, upstream errors, output budgets, cancellation
and child-process termination. The shared connector type contains opaque adapter-owned prepared bytes. Provider
request paths and query parameters stay inside each adapter.
The fixture never uses production credentials or grants. The MCP fixture runs the actual Rust client with an isolated
Workload API and verifies the expected peer, rejection of a trusted certificate bearing another SPIFFE identity, and
lookup after lost responses without another execution. Interactive stdio pagination tests traverse 125 tools exactly
once, check full and partial final pages and an empty catalog, reject malformed, out-of-range and stale cursors,
and change authorized discovery between pages while asserting zero execution dispatches or lookups. Production cluster
acceptance is a distinct rollout gate.

## AgentRun connector

`agents` is the first enrolled MCP mutation provider. The existing Agents service serves `/mcp/relay/lab`; no extra
scheduler or runner is introduced. Its `spiffe_jwt` authentication obtains a fresh Relay JWT-SVID for the exact
`https://agents.k8s.proompteng.ai/mcp/relay` audience. Agents verifies the signed token against the SPIRE JWKS,
expiry, audience and exact Relay workload identity. TLS reaches the existing private ingress; the deployment's
host alias pins that hostname to the configured ingress VIP rather than the public DNS route.

The reviewed profile in `argocd/applications/agents/relay-targets.json` fixes workspace, namespace UID, agent,
repository, base branch, VCS and credential bindings, and a two-hour Job deadline. Callers supply task text and an
optional token budget. `start_run`, `list_runs`, `get_run`, `read_logs`, `get_result` and `cancel_run` are generated
from the Agents Zod contracts by `bun run services/agents/scripts/generate-relay-registration.ts`; CI runs `--check`.

Ofz owns `agents.target` policy with separate `agents.runs.read`, `agents.runs.logs`, `agents.runs.start` and
`agents.runs.cancel` actions. Registering `agents/lab` does not grant these actions. Workspace administrators assign
them in the existing admin portal. Starting a run permits code execution using that profile's repository credentials;
review this authority independently from Kubernetes read access.

The public run ID is the original Relay operation UUID. Agents reserves it durably before calling its existing
submission handler with a deterministic resource name. After any uncertain response, use `get_run` with that ID.
Observation can repair the database projection from the accepted Kubernetes object, but never submits another run.
An unconfirmed write stays `started` in Relay until it has a confirmed outcome; a timeout is not a confirmed failure.
Cancellation uses the existing UID-fenced handler. Logs select the original run UID and fall back to retained logs;
results read the recorded artifact key. Namespace recreation invalidates the target profile.

Tengri installs the registered operations through Connections and preserves read/write annotations. Its compact run
card refreshes through Relay and can cancel with current permission; uncertain cancellation is never automatically
retried. Standalone OpenCode discovers the same tools through its existing `relay-client` bridge. Both use Ofz
permissions and their existing client approval flow. AgentRun workers consuming Relay are a separate feature.

Rollout: qualify/install the Ofz schema, migrate and release Agents, then release Relay and the clients through their
existing Kargo stages. Run the database migration before enabling the endpoint. A reader grant must work before a
start/cancel grant is exercised. Verify a harmless task to completion in each client, including logs and result,
then verify that lost-response lookup preserves its original run ID. Revoke target permissions or remove its
registration to disable new connector use; retain submission receipts, AgentRun projections and artifacts for recovery.
