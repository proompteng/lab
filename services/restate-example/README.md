# @proompteng/restate-example

Minimal local Restate + Effect example. Galactic no longer deploys this sample. Use a local Restate instance
for the steps below.

It exposes one Restate service:

- `Greeter/greet` — validates input with Effect Schema, records two durable `ctx.run` steps, sleeps durably for a small interval, and returns a greeting response.

Local run:

```sh
cp app-package.json package.json
bun install
bun src/server.ts
curl -X POST http://localhost:9070/deployments \
  -H 'content-type: application/json' \
  -d '{"uri":"http://localhost:9080","use_http_11":true,"force":true}'
curl -X POST http://localhost:8080/Greeter/greet \
  -H 'content-type: application/json' \
  -d '{"name":"GitOps"}'
```

The sample intentionally uses `app-package.json` instead of `package.json` so it is not added to the root Bun workspace and does not perturb existing Nix image dependency hashes.
