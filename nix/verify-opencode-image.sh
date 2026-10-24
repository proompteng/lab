#!/usr/bin/env bash
set -euo pipefail
image_tar="$(readlink -f "$1")"
image_ref="$(tar -xOf "$image_tar" manifest.json | jq -er '.[0].RepoTags[0]')"
docker load --input "$image_tar" >/dev/null
image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
volume="$(docker volume create)"
container=''
cleanup() {
  if [[ -n "$container" ]]; then docker rm --force "$container" >/dev/null; fi
  docker volume rm "$volume" >/dev/null
}
trap cleanup EXIT
# Kubernetes normally supplies this ownership through fsGroup.
docker run --rm --network none --user 0:0 --entrypoint bash -v "$volume:/data" "$image_id" \
  -c 'mkdir -p /data/home /data/workspace/lab; chown -R 65532:65532 /data'
container="$(docker run --detach --network none --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 2g --cpus 2 \
  -v "$volume:/var/lib/opencode" -v "$volume:/workspace" \
  "$image_id" bash -c 'git init /workspace/lab >/dev/null; exec /bin/opencode-server')"
probe() {
  docker exec "$container" python3 -c '
import base64,json,os,urllib.request,urllib.error
from pathlib import Path
url="http://127.0.0.1:4096"
for path,method in [("/api/info","GET"),("/api/pair","POST")]:
    try:
        urllib.request.urlopen(urllib.request.Request(url+path,method=method),timeout=2)
        raise AssertionError("Unauthenticated request succeeded")
    except urllib.error.HTTPError as error:
        assert error.code==401
password=Path(os.environ["HOME"],"server-password").read_text().strip()
request=urllib.request.Request(url+"/api/info",headers={"Authorization":"Basic "+base64.b64encode(("opencode:"+password).encode()).decode()})
info=json.load(urllib.request.urlopen(request,timeout=2))
assert info["version"]=="2.1.3"
assert Path("/proc/1/comm").read_text().strip()=="tini"
'
}
ready=false
for _ in {1..45}; do
  if probe 2>/dev/null; then ready=true; break; fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then docker logs "$container" >&2; exit 1; fi
docker exec "$container" bash -euc '
for tool in opencode node bun go python3 uv ruby git gh nix kubectl helm kustomize kubeconform tofu buf make cc cmake rustc cargo rustfmt cargo-clippy ruff lua protoc promtool alloy ssh sqlite3 docker buildctl jq rg; do
  command -v "$tool" >/dev/null
done
cd /workspace/lab
printf "export const total = (a, b) => a + b\n" > total.js
printf "import { test, expect } from \"bun:test\"; import { total } from \"./total.js\"; test(\"total\", () => expect(total(2,3)).toBe(5));\n" > total.test.js
bun test total.test.js
bun build total.js --outfile=/workspace/total.bundle.js
sha256sum "$HOME/server-password" > /workspace/password.sha256
'
docker exec -i "$container" bash -eu <<'NIX_PROOF'
nix build --no-link --impure --expr 'derivation { name = "opencode-development-proof"; system = builtins.currentSystem; builder = "/bin/bash"; args = [ "-c" "printf native-nix > $out" ]; }'
NIX_PROOF
docker restart --time 10 "$container" >/dev/null
ready=false
for _ in {1..30}; do
  if probe 2>/dev/null; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker exec "$container" bash -euc 'sha256sum -c /workspace/password.sha256; test -s /workspace/total.bundle.js; cd /workspace/lab; bun test total.test.js'
printf '%s\n' 'OpenCode v2: authenticated server, preinstalled tools, real edit/test/build and restart persistence verified offline.'

docker rm --force "$container" >/dev/null
container="$(docker run --detach --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --tmpfs /var/lib/bayn-opencode:rw,nosuid,nodev,uid=65532,gid=65532 \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 1g --cpus 1 \
  -e BAYN_PUBLIC_INFORMATION_PROXY=http://127.0.0.1:9 \
  "$image_id" node /app/opencode/research.js)"
ready=false
for _ in {1..45}; do
  if docker exec "$container" curl --connect-timeout 1 --max-time 3 --fail --silent http://127.0.0.1:4096/readyz >/dev/null; then ready=true; break; fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then docker logs "$container" >&2; exit 1; fi
printf '%s\n' 'Packaged bounded research gateway started its pinned native child offline.'
