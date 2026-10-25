# Relay platform executor

Relay executes registered connector operations after Ofz authorizes their exact resources. Tengri and standalone
OpenCode use the same protobuf execution contract. They have separate identities and authority.

The first adapter is Kubernetes: pod status, bounded pod logs, and namespace events. These operations execute against
the configured cluster API using Relay's projected service-account credential. Pod status omits pod specifications and
inline environment values. Logs are plain text. The client cannot supply a URL, credential, HTTP method, exec command,
watch, or arbitrary Kubernetes path. Effectful operations require a separate execution contract and are rejected.

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

Ofz supplies Relay's enrolled clients. Relay refreshes that roster every two seconds, clears it on a failed refresh,
and rejects a roster older than ten seconds. The same roster guards TLS handshakes and every RPC, including existing
connections. Adding a client requires no second identity allowlist in Relay.

## Clients

`packages/platform-client` supplies Rust protobuf types, exact-peer SPIFFE TLS and the shared execution body.
The `relay-client` binary is an MCP stdio bridge for independent workloads such as OpenCode. Each operation asserts
that workload's registered identity; it contains no Tengri workspace or human session.

The Tengri BFF installs a proof-bound delegation into the current guest. Ofz creates it inactive. The BFF activates it
only after the guest acknowledges its exact delegation ID and proof-key thumbprint. Ofz checks the issuer's current
permission, membership, workspace ownership, running generation, grant expiry and recovery generation on every call.
DPoP binds the credential, key, destination, method and exact body, and each proof nonce can be consumed only once.

## Configuration and validation

`RELAY_CONFIG_FILE` names a strict JSON connector definition; `OFZ_GRPC_TARGET` names the Ofz DNS authority.
`SPIFFE_ENDPOINT_SOCKET` supplies the workload API. Cluster endpoint, CA file, projected token file and immutable
namespace identities are operator configuration. Tokens are read for every invocation so projection rotation works.

```sh
cargo fmt --manifest-path services/relay/Cargo.toml --check
cargo clippy --manifest-path services/relay/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/relay/Cargo.toml --locked --all-targets
bash services/ofz/qualify-platform.sh
bash services/ofz/test-control.sh platform
bash services/relay/test-client.sh
```

The integration fixture uses real PostgreSQL and SpiceDB plus an isolated TLS Kubernetes API. It never uses production
credentials or grants. The MCP fixture runs the actual Rust client with an isolated Workload API and verifies the
expected peer and rejection of a trusted certificate bearing another SPIFFE identity. Production cluster acceptance
is a distinct rollout gate.
