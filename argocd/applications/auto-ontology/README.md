# Auto Ontology on Galactic

The [web UI](https://auto-ontology.ide-newton.ts.net) and [MCP endpoint](https://auto-ontology-mcp.ide-newton.ts.net/mcp) use private Tailscale HTTPS. MCP clients sign in through the web UI. The bootstrap login is `admin@auto-ontology.ide-newton.ts.net`. Authorized operators can retrieve its password from the `AUTO_ONTOLOGY_ADMIN_PASSWORD` field of the `auto-ontology-secrets` Secret in this namespace.

Sync the reviewed revision of Saigak first. Verify the Radeon serves the embedding model, then sync Nemotron Rerank and verify `POST /v1/ranking` on Altra. Sync Auto Ontology last. The Helm chart runs the Alembic and Prisma migrations against its own PostgreSQL volume. New installations start with an empty catalog.

The model settings in the SealedSecret template point to Flamingo, Saigak, and Nemotron Rerank. `DEFAULT_MODELS_API_KEY` supplies the nonempty string the client library requires for these unauthenticated cluster services.

## PostgreSQL commit durability

The single-instance catalog database uses [`synchronous_commit=off`](https://www.postgresql.org/docs/19/wal-async-commit.html)
so Better Auth's per-request API key updates release row locks without waiting for a Ceph RBD WAL flush. Crash recovery
remains consistent, but a crash can lose recently acknowledged writes. Source catalogs and knowledge bundles can be
re-synced; revisit this setting if acknowledged writes must survive a crash or if synchronous replication is introduced.

## Verify MCP OAuth discovery

The MCP resource advertises the Better Auth issuer `https://auto-ontology.ide-newton.ts.net/api/auth`.
[RFC 8414 §3.1](https://www.rfc-editor.org/rfc/rfc8414.html#section-3.1) puts
`/.well-known/oauth-authorization-server` **before** the issuer path. The Tailscale web ingress sends that path to
a discovery-only HAProxy service. It accepts only `GET` and `HEAD` on the exact path and forwards to the frontend's
existing public metadata handler without client headers, query parameters, or credentials. The legacy metadata
paths and all sign-in and MCP traffic still go to their original services.

Argo CD waits for the proxy's metadata readiness probe before updating the ingress in sync wave 2. If needed,
revert this change in Git and sync the revert; that restores the previous routing without changing the issuer.
Remove the proxy and its ingress rule when the pinned frontend includes
[NVIDIA's native route](https://github.com/NVIDIA/auto-ontology/pull/648).

To verify the rendered GitOps contract locally with Helm 3:

```sh
nix develop -c bun test argocd/applications/auto-ontology/oauth-discovery.test.ts
```

After Argo CD sync, run from the tailnet with no credentials. Each metadata URL must respond directly with HTTP 200 and the same issuer; an unauthenticated MCP request must still return HTTP 401.

```bash
set -euo pipefail
mcp_origin=https://auto-ontology-mcp.ide-newton.ts.net
issuer=https://auto-ontology.ide-newton.ts.net/api/auth
auth_origin=${issuer%/api/auth}
discovery=/.well-known/oauth-authorization-server

curl -fsS -w '\n%{response_code}\n' "$mcp_origin/.well-known/oauth-protected-resource/mcp" |
  jq -es --arg issuer "$issuer" 'length == 2 and .[0].authorization_servers == [$issuer] and .[1] == 200'

for url in "$auth_origin$discovery${issuer#"$auth_origin"}" "$auth_origin$discovery" "$issuer$discovery"; do
  curl -fsS -w '\n%{response_code}\n' "$url" |
    jq -es --arg issuer "$issuer" 'length == 2 and .[0].issuer == $issuer and .[1] == 200'
done

status=$(curl -sS -o /dev/null -w '%{response_code}' -H 'Accept: text/event-stream' "$mcp_origin/mcp")
test "$status" = 401
```
