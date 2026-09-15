# @proompteng/khoshut

Khoshut is a Bun service with an example Inngest workflow.

It exposes:

- `POST /api/inngest` for Inngest function registration and execution.
- `GET /healthz` for readiness.
- `POST /trigger` to emit an example event to Inngest.

## Local run

```bash
cp services/khoshut/.env.example services/khoshut/.env
bun run --filter @proompteng/khoshut dev
```

## Trigger the workflow

```bash
curl -sS -X POST http://127.0.0.1:3000/trigger \
  -H 'content-type: application/json' \
  -d '{"message":"Mend!"}'
```

## Notes

- `INNGEST_BASE_URL` should point at your Inngest server.
- `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` must match the keys configured in the Inngest deployment.
- The workflow listens for `khoshut/workflow.requested`.
