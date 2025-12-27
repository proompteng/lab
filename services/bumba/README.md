# bumba

Temporal worker that enriches repository files using AST context + self-hosted models and stores embeddings in the Jangar database.

## Notes
- Schema is owned by Jangar; this service only reads/writes through shared tables.
- Configure Temporal connection via `TEMPORAL_*` env vars.
- Mount the Jangar workspace PVC at `/workspace` for file access.
- Enrichment skips directory paths and falls back with a timeout summary if the model request times out.
