#!/usr/bin/env bash
set -euo pipefail

image="${1:?expected the final guest image}"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
inspection="$(mktemp)"
trap 'rm -f "$inspection"' EXIT
docker image inspect "$image" > "$inspection"
python3 - "$inspection" "$script_directory/Dockerfile" <<'PY'
import hashlib, json, shlex, sys

image = json.load(open(sys.argv[1]))[0]
layers = image["RootFS"]["Layers"]
# WORKDIR can emit an empty tar after COPY. Every populated file must be in
# the first layer; no Ubuntu or other cached filesystem parent may precede it.
empty = "sha256:" + hashlib.sha256(bytes(1024)).hexdigest()
assert layers and all(layer == empty for layer in layers[1:]), layers
# Preserve the original runtime ENV rather than silently dropping configuration
# when packaging its filesystem in a scratch-based final image.
lines = iter(open(sys.argv[2]))
for line in lines:
    if line.startswith("ENV "):
        environment = line[4:]
        while environment.rstrip().endswith("\\"):
            environment = environment.rstrip()[:-1] + next(lines)
        break
expected = dict(item.split("=", 1) for item in shlex.split(environment))
config = image["Config"]
assert dict(item.split("=", 1) for item in config["Env"]) == expected
assert config["User"] == "1000:1000"
assert config["WorkingDir"] == "/home/nanoagent"
assert config["Entrypoint"] == ["/usr/local/bin/nanoagent"]
assert config["ExposedPorts"] == {"8080/tcp": {}}
print(f"first_diff_id={layers[0]} first_parent=<empty>")
PY
# These regular seed files alone exceed the old filesystem's entire capacity.
# This complete first-layer diff cannot be a successfully committed 512 MiB
# parent; containerd applies it with parent="" and copies the new scratch.
docker run --rm --network none --entrypoint python3 "$image" -B -c '
import glob, os
size = sum(os.stat(path).st_size for path in glob.glob("/usr/share/nanoagent/*.tar.xz"))
assert size > 536870912, size
print(f"first_layer_seed_bytes={size} exceeds_512MiB=true")
'
