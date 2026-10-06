#!/usr/bin/env bash
set -euo pipefail

image="${1:?expected the final guest image}"
seed_directory="${2:?expected the exported native tool seed artifact directory}"
controller_image="${3:?expected the paired controller image}"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
inspection="$work/image.json"
seed_volume=""
cleanup() {
  if [[ -n "$seed_volume" ]]; then docker volume rm "$seed_volume" >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT
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
# The root must fit the installed scratch without seed files hidden by a mount.
docker run --rm --network none --entrypoint python3 "$image" -B -c '
import glob, os
assert not glob.glob("/usr/share/nanoagent/*.tar.xz")
assert os.path.isfile("/etc/nanoagent-seed-files.sha256")
assert "filesystem_bytes=536870912" in open("/etc/nanoagent-rootfs-validation.txt").read()
print("guest_root_bytes=536870912 seed_payload=<external-private-disk>")
'

# Verify the artifact used by this exact native controller build. debugfs reads
# the filesystem without a loop device, a host mount, or a privileged container.
[[ "$(stat -c %s "$seed_directory/nanoagent-seeds.ext4")" = 1073741824 ]]
(cd "$seed_directory" && sha256sum --check nanoagent-seeds.ext4.sha256)
e2fsck -f -n "$seed_directory/nanoagent-seeds.ext4"
mkdir "$work/seeds"
debugfs -R "rdump / $work/seeds" "$seed_directory/nanoagent-seeds.ext4"
(cd "$work/seeds" && sha256sum --check seed-files.sha256)
expected_digest="$(awk '{ print $1 }' "$seed_directory/nanoagent-seeds.ext4.sha256")"
test "$(docker run --rm --network none "$controller_image" --validate-tool-seeds)" = "seed_image_sha256=$expected_digest"

# Copy the verified disk readback into a private Docker volume as root. This
# preserves the production seed ownership while the guest runs as UID 1000.
seed_volume="$(docker volume create)"
docker run --rm --network none --user 0:0 \
  --mount "type=bind,source=$work/seeds,target=/source,readonly" \
  --mount "type=volume,source=$seed_volume,target=/seeds" \
  --entrypoint /bin/sh "$image" -ceu 'cp -a /source/. /seeds/; chown -R 0:0 /seeds'
docker run --rm --network none --user 1000:1000 \
  --mount "type=volume,source=$seed_volume,target=/usr/share/nanoagent,readonly" \
  --entrypoint /bin/bash "$image" -ceu '
    cmp /etc/nanoagent-seed-files.sha256 /usr/share/nanoagent/seed-files.sha256
    cd /usr/share/nanoagent
    sha256sum --check /etc/nanoagent-seed-files.sha256
  '
# This fixture times both fresh installation and retained-home helper reuse,
# and verifies all tools plus preservation of user configuration and sessions.
docker run --rm --interactive --network none --user 1000:1000 \
  --tmpfs /home/nanoagent:uid=1000,gid=1000,mode=0750,exec \
  --mount "type=volume,source=$seed_volume,target=/usr/share/nanoagent,readonly" \
  --entrypoint /bin/bash "$image" -s < "$script_directory/test-developer-tools.sh"
