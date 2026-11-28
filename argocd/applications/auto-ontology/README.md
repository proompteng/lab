# Auto Ontology on Galactic

The [web UI](https://auto-ontology.ide-newton.ts.net) and [MCP endpoint](https://auto-ontology-mcp.ide-newton.ts.net/mcp) use private Tailscale HTTPS. MCP clients sign in through the web UI. The bootstrap login is `admin@auto-ontology.ide-newton.ts.net`. Authorized operators can retrieve its password from the `AUTO_ONTOLOGY_ADMIN_PASSWORD` field of the `auto-ontology-secrets` Secret in this namespace.

Sync the reviewed revision of Saigak first. Verify the Radeon serves the embedding model, then sync Nemotron Rerank and verify `POST /v1/ranking` on Altra. Sync Auto Ontology last. The Helm chart runs the Alembic and Prisma migrations against its own PostgreSQL volume. New installations start with an empty catalog.

The model settings in the SealedSecret template point to Flamingo, Saigak, and Nemotron Rerank. `DEFAULT_MODELS_API_KEY` supplies the nonempty string the client library requires for these unauthenticated cluster services.

The ingestion worker gives Flamingo up to 180 seconds per HTTP request. In 1.3.0 the NVIDIA SDK otherwise passes an explicit 60-second timeout, overriding the worker setting and dropping column-description batches after retries. The init container passes the worker setting to the SDK constructor. Remove it when the upstream client forwards that setting. After an incremental compile, check the actual number of undescribed attributes on each catalogued source:

```sh
kubectl -n auto-ontology exec deploy/ingestion -c ingestion -- python -c 'from auto_ontology.semantic.attribute_descriptions import fetch_attributes_to_describe as pending; print({db: len(pending(db)) for db in ("agents", "bayn")})'
```

## Verify questions across the Agents and Bayn databases

The UI and MCP send questions without a database selector. Version 1.3.0 can retrieve candidate tables from both databases and then fail to execute SQL that reads from just one. The backend applies the PostgreSQL routing changes from [NVIDIA's upstream fix](https://github.com/NVIDIA/auto-ontology/commit/a12fec75226a54ffc91752cca9538f1f01f760eb) to its pinned image at startup. The tables referenced by the SQL must resolve to one connector. Remove the patch and its init containers when upgrading to a release containing the fix.

From each approved read-only source, obtain the reference count for the same closed period:

```sql
-- Agents
SELECT count(*) FROM agents_audit.agent_runs WHERE created_at < TIMESTAMPTZ '2026-11-26 00:00:00+00';
-- Bayn standby
SELECT count(*) FROM public.broker_events WHERE occurred_at < TIMESTAMPTZ '2026-11-26 00:00:00+00';
```

From the tailnet, supply a read/chat token in `AUTO_ONTOLOGY_API_TOKEN` and run
`bun argocd/applications/auto-ontology/verify-queries.ts <agents-count> <bayn-count>`.
It submits both questions to the private frontend without a source hint and checks the returned SQL relation and count. At release, repeat the two questions in the signed-in UI and with the public MCP server's authenticated `ask_question` tool. Both must agree with the reference counts.

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
