# Bayn

Bayn is an Effect-TS service foundation. This initial runtime deliberately contains only process lifecycle and health
handling; strategy evaluation, scheduling, broker access, order submission, Signal, and TigerBeetle integrations are out
of scope.

## Runtime

Effect owns configuration loading, dependency injection, server acquisition, readiness evaluation, signal-driven
shutdown, and typed configuration/server/dependency failures. The production dependency registry is empty until later
Bayn capabilities provide bounded probes through `DependencyRegistry`.

| Variable    | Default   | Purpose                             |
| ----------- | --------- | ----------------------------------- |
| `BAYN_HOST` | `0.0.0.0` | HTTP listen address                 |
| `BAYN_PORT` | `8080`    | HTTP listen port (1 through 65,535) |

No credential configuration is accepted by this foundation.

### Health endpoints

- `GET /livez` returns `200` while the process can serve requests. It intentionally does not call dependencies.
- `GET /readyz` returns `200` only after startup completes and every registered bounded dependency probe succeeds. It
  returns `503` during startup, shutdown, probe failure, or probe timeout.
- Every other path and every non-`GET` request returns `404`; there is no order API.

## Development

```sh
bun install
bun run --cwd services/bayn tsc
bun run --cwd services/bayn lint:oxlint
bun run --cwd services/bayn lint:oxlint:type
bunx oxfmt --check services/bayn .github/workflows/bayn-ci.yml
bun run --cwd services/bayn test
bun run build:bayn
```

`bun run build:bayn` builds the production image from the repository root. The Dockerfile pins the multi-platform Bun
1.3.14 image by OCI digest and installs the committed lockfile with `--frozen-lockfile`.
