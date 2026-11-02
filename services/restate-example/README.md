# @proompteng/restate-example

Minimal Restate + Effect service used to prove the self-hosted Restate GitOps deployment end to end.

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

The GitOps example under `argocd/applications/restate-example` runs a pre-bundled Bun artifact from split ConfigMaps. Regenerate the bundle after changing `src/*.ts`:

```sh
rm -rf /tmp/restate-example-bundle
mkdir -p /tmp/restate-example-bundle/src
cp services/restate-example/app-package.json /tmp/restate-example-bundle/package.json
cp services/restate-example/src/domain.ts /tmp/restate-example-bundle/src/domain.ts
cp services/restate-example/src/server.ts /tmp/restate-example-bundle/src/server.ts
(
  cd /tmp/restate-example-bundle
  bun install --no-save --ignore-scripts
  bun build src/server.ts --target=bun --minify --outfile=server.min.js
  gzip -c server.min.js > server.min.js.gz
  base64 -w0 server.min.js.gz > server.min.js.gz.b64
)
rm -f argocd/applications/restate-example/source/*.b64
python3 - <<'PY'
from pathlib import Path
encoded = Path('/tmp/restate-example-bundle/server.min.js.gz.b64').read_text()
out = Path('argocd/applications/restate-example/source')
out.mkdir(parents=True, exist_ok=True)
for i in range(0, len(encoded), 450_000):
    (out / f'part-{i // 450_000:02d}.b64').write_text(encoded[i:i + 450_000])
PY
```

The sample intentionally uses `app-package.json` instead of `package.json` so it is not added to the root Bun workspace and does not perturb existing Nix image dependency hashes.
