# `@proompteng/temporal-bun-sdk`

Run Temporal workers and clients on Bun.

Docs: <https://docs.proompteng.ai/docs/temporal-bun-sdk>

## Quickstart

Run this outside another Bun workspace:

```bash
bunx @proompteng/temporal-bun-sdk init hello-worker
cd hello-worker
bun install

cat > .env <<'EOF'
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=hello-bun
EOF
```

Start Temporal:

```bash
temporal server start-dev --headless
```

Start the worker:

```bash
bun run dev
```

Start a workflow in another shell:

```bash
temporal workflow start \
  --task-queue hello-bun \
  --type helloWorkflow \
  --input '"Codex"'
```

## Add to an existing Bun project

```bash
bun add @proompteng/temporal-bun-sdk
```

## Strict mode

The generated worker uses `workflowGuards: 'warn'` so local setup works with
`temporal server start-dev`.

If you want strict mode, set `workflowGuards: 'strict'` in your worker and
configure worker versioning and build IDs.

## What is included

- Bun worker and client runtime
- Config loader for local, self-hosted, and Temporal Cloud setups
- TLS and API key support
- Docker build helper
- Replay tooling
- `temporal-bun` CLI for scaffolding and diagnostics

## Docs

- Main guide: <https://docs.proompteng.ai/docs/temporal-bun-sdk>
- Temporal Cloud and TLS: <https://docs.proompteng.ai/docs/temporal-bun-sdk-cloud-tls>
- Bun SDK vs official TypeScript SDK: <https://docs.proompteng.ai/docs/temporal-bun-sdk-comparison>
- Example app: <https://github.com/proompteng/lab/tree/main/packages/temporal-bun-sdk-example>
- Issues: <https://github.com/proompteng/lab/issues>

## License

MIT © ProomptEng AI
