# Memories runbook

## Schema

Memories are stored in Postgres using the schema in `schemas/embeddings/memories.sql`.

## Default self-hosted settings

```bash
export OPENAI_API_BASE_URL='http://saigak.saigak.svc.cluster.local:11434/v1'
export OPENAI_EMBEDDING_MODEL='qwen3-embedding-saigak:0.6b'
export OPENAI_EMBEDDING_DIMENSION='1024'
```

## Validation

- Confirm embedding dimension matches the DB column type.
- Use `retrieve-memory` to validate results.

## Example

```bash
bun run --filter memories retrieve-memory   --query "bumba enrichRepository"   --limit 3
```
