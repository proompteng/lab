# Auto Ontology on Galactic

The [web UI](https://auto-ontology.ide-newton.ts.net) and [MCP endpoint](https://auto-ontology-mcp.ide-newton.ts.net/mcp) use private Tailscale HTTPS. MCP clients sign in through the web UI. The bootstrap login is `admin@auto-ontology.ide-newton.ts.net`. Authorized operators can retrieve its password from the `AUTO_ONTOLOGY_ADMIN_PASSWORD` field of the `auto-ontology-secrets` Secret in this namespace.

Sync the reviewed revision of Saigak first. Verify the Radeon serves the embedding model, then sync Nemotron Rerank and verify `POST /v1/ranking` on Altra. Sync Auto Ontology last. The Helm chart runs the Alembic and Prisma migrations against its own PostgreSQL volume. New installations start with an empty catalog.

The model settings in the SealedSecret template point to Flamingo, Saigak, and Nemotron Rerank. `DEFAULT_MODELS_API_KEY` supplies the nonempty string the client library requires for these unauthenticated cluster services.
