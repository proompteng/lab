# Relay platform executor

Relay executes registered connector operations after Ofz authorizes their exact resources. Tengri and standalone
OpenCode use the same protobuf execution contract. They have separate identities and authority.

The first adapter is Kubernetes: pod status, bounded pod logs, and namespace events. These operations execute against
the configured cluster API using Relay's projected service-account credential. Pod status omits pod specifications and
inline environment values. Logs are plain text. The client cannot supply a URL, credential, HTTP method, exec command,
watch, or arbitrary Kubernetes path. Effectful operations require a separate execution contract and are rejected.

Registered HTTP, CLI and upstream MCP adapters use the same authorization, discovery and receipt path. Each operation binds one
fixed resource, a catalog action and a reviewed JSON input schema. Its target is derived from the registration;
arguments cannot select another account, destination or command. These adapters support approved read operations.
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

For example, after enrolling `inventory.account` and `inventory.items.read` in Ofz:

```json
{
  "version": 1,
  "connectors": [{
    "type": "http",
    "id": "inventory",
    "endpoint": "https://inventory.example.com/",
    "authentication": { "type": "bearer_file", "path": "/var/run/inventory/token" },
    "operations": [{
      "operation": {
        "name": "items",
        "description": "Search the approved inventory account",
        "action": "inventory.items.read",
        "target": { "name": "Team inventory", "kind": "inventory.account", "id": "inventory/team" },
        "input_schema": {
          "type": "object",
          "properties": { "query": { "type": "string", "maxLength": 128 } },
          "required": ["query"],
          "additionalProperties": false
        }
      },
      "method": "GET",
      "path": "/items"
    }]
  }]
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

The maintained MCP SDK owns protocol negotiation, message correlation and tool calls. Registration requires an
operator-reviewed read operation. Relay checks the upstream tool's exact input schema before dispatch and rejects
explicit effectful or destructive hints. Optional MCP annotations do not grant authority. A changed or missing tool
requires reviewing the registration; provider descriptions and instructions cannot replace the approved catalog. An MCP tool error
remains a failed execution. The complete invocation has a ten-second deadline, and JSON messages, HTTP bodies and
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
lookup after lost responses without another execution. Production cluster acceptance is a distinct rollout gate.
