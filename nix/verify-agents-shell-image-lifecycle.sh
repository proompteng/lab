#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo 'Usage: verify-agents-shell-image-lifecycle <nix-image-tar>' >&2
  exit 2
fi

image_tar="$(readlink -f "$1")"
test -f "${image_tar}"
image_ref="$(tar -xOf "${image_tar}" manifest.json | jq -er '.[0].RepoTags | if length == 1 then .[0] else error("expected one image tag") end')"
docker load --input "${image_tar}" >/dev/null
image_id="$(docker image inspect --format '{{.Id}}' "${image_ref}")"
container=''
cleanup() {
  if [[ -n "${container}" ]]; then
    docker rm --force "${container}" >/dev/null || true
  fi
}
trap cleanup EXIT

container="$(docker run --detach --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 1g --cpus 1 --env PORT=8080 "${image_id}")"
ready=false
for _ in {1..45}; do
  if docker exec "${container}" curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${container}")" != 'true' ]]; then
    break
  fi
  sleep 1
done
if [[ "${ready}" != 'true' ]]; then
  docker logs "${container}" >&2
  echo 'Agents Shell image did not become healthy.' >&2
  exit 1
fi

docker exec "${container}" python3 -c 'from pathlib import Path; assert Path("/proc/1/comm").read_text().strip() == "tini", "Tini must own PID 1"'
docker exec "${container}" python3 -c 'import os, time
from pathlib import Path
pids = []
for _ in range(16):
    pid = os.fork()
    if pid == 0:
        time.sleep(0.1)
        os._exit(0)
    pids.append(pid)
Path("/tmp/agents-shell-orphans").write_text(" ".join(map(str, pids)))
os._exit(0)'

docker exec "${container}" python3 -c 'from pathlib import Path
import time
pids = Path("/tmp/agents-shell-orphans").read_text().split()
assert len(pids) == 16, "expected 16 orphaned descendants"
def remaining():
    return any(Path("/proc", pid).exists() for pid in pids)
def zombies():
    result = []
    for path in Path("/proc").glob("[0-9]*/status"):
        try:
            status = path.read_text()
        except FileNotFoundError:
            continue
        if "State:\tZ" in status:
            result.append(path.parent.name)
    return result
deadline = time.monotonic() + 3
while time.monotonic() < deadline:
    time.sleep(0.2)
    if not remaining() and not zombies():
        break
assert not remaining(), "orphaned descendants remain in /proc"
assert not zombies(), "orphaned descendants were not reaped"
print("PID 1 reaped 16 orphaned descendants; zero zombies")'

started="${SECONDS}"
docker stop --time 5 "${container}" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "${container}")" = '0'
test "$(docker inspect --format '{{.State.OOMKilled}}' "${container}")" = 'false'
test "$((SECONDS - started))" -lt 5
echo 'Agents Shell exited with code 0 before the SIGKILL deadline.'
