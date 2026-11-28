#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

export HOME=/mnt/server
mkdir -p "$HOME/steamcmd" "$HOME/.steam/sdk32" "$HOME/.steam/sdk64"
cd "$HOME/steamcmd"
curl --fail --show-error --location --retry 3 \
  https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
  --output /tmp/dst-steamcmd.tar.gz
tar -xzf /tmp/dst-steamcmd.tar.gz
./steamcmd.sh +force_install_dir "$HOME" +login anonymous +app_update 343050 validate +quit
test -x "$HOME/bin64/dontstarve_dedicated_server_nullrenderer_x64"
cp linux32/steamclient.so "$HOME/.steam/sdk32/steamclient.so"
cp linux64/steamclient.so "$HOME/.steam/sdk64/steamclient.so"

# Provisioning embeds the reviewed launcher here; no mutable GitHub downloads.
__DST_LAUNCHER__
chmod 0755 "$HOME/start-dst.sh"

cluster="$HOME/DoNotStarveTogether/config/server"
mkdir -p "$cluster/Master" "$cluster/Caves"
write_new() {
  if [[ -e "$1" ]]; then cat > /dev/null; else cat > "$1"; fi
}

# Preserve configurations, credentials and saves across reinstall/update.
password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
shard_key=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
write_new "$cluster/cluster.ini" <<EOF
[GAMEPLAY]
game_mode = survival
max_players = 2
pvp = false
pause_when_empty = true

[NETWORK]
cluster_name = Galactic - Don't Starve Together
cluster_description = Private forest and caves on the Galactic tailnet
cluster_password = $password
cluster_intention = cooperative
lan_only_cluster = false
offline_cluster = false
autosaver_enabled = true
enable_vote_kick = false

[MISC]
console_enabled = true

[SHARD]
shard_enabled = true
bind_ip = 127.0.0.1
master_ip = 127.0.0.1
master_port = 11001
cluster_key = $shard_key
EOF
unset password shard_key

write_new "$cluster/Master/server.ini" <<'EOF'
[NETWORK]
server_port = 10999
[SHARD]
is_master = true
[STEAM]
authentication_port = 8766
master_server_port = 27016
EOF
write_new "$cluster/Caves/server.ini" <<'EOF'
[NETWORK]
server_port = 11000
[SHARD]
is_master = false
name = Caves
id = 2
[STEAM]
authentication_port = 8767
master_server_port = 27017
EOF
write_new "$cluster/Master/worldgenoverride.lua" <<'EOF'
return { override_enabled = true, preset = "SURVIVAL_TOGETHER" }
EOF
write_new "$cluster/Caves/worldgenoverride.lua" <<'EOF'
return { override_enabled = true, preset = "DST_CAVE" }
EOF
printf '%s\n' 'DST installed. Add your Klei cluster_token.txt in DoNotStarveTogether/config/server before starting.'
