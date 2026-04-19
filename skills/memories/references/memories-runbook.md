# Memories runbook

## Schema

Memories are stored in Postgres using the schema in `schemas/embeddings/memories.sql`.

## Default self-hosted settings

```bash
export OPENAI_API_BASE_URL='http://saigak.saigak.svc.cluster.local:11434/v1'
export OPENAI_EMBEDDING_API_BASE_URL='http://saigak.saigak.svc.cluster.local:11435/api'
export OPENAI_EMBEDDING_MODEL='qwen3-embedding-saigak:8b'
export OPENAI_EMBEDDING_DIMENSION='4096'
```

## Validation

- Confirm embedding dimension matches the DB column type.
- Use `retrieve-memory` to validate results.

## Example

```bash
bun run --filter memories retrieve-memory   --query "bumba enrichRepository"   --limit 3
```
