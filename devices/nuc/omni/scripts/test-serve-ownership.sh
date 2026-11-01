#!/usr/bin/env bash
set -Eeuo pipefail
component_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly component_dir
expected="$(jq --sort-keys --arg host nuc.ide-newton.ts.net --from-file "$component_dir/serve-owned.jq" "$component_dir/tailscale-serve.json")"
combined="$(jq '.TCP["9444"]={"HTTPS":true} | .Web["nuc.ide-newton.ts.net:9444"]={"Handlers":{"/":{"Proxy":"http://127.0.0.1:9445"}}}' "$component_dir/tailscale-serve.json")"
actual="$(jq --sort-keys --arg host nuc.ide-newton.ts.net --from-file "$component_dir/serve-owned.jq" <<< "$combined")"
[[ "$actual" == "$expected" ]]
changed="$(jq '.Web["nuc.ide-newton.ts.net:443"].Handlers["/"].Proxy="http://127.0.0.1:9999"' <<< "$combined" | jq --sort-keys --arg host nuc.ide-newton.ts.net --from-file "$component_dir/serve-owned.jq")"
[[ "$changed" != "$expected" ]]
public="$(jq '.AllowFunnel["nuc.ide-newton.ts.net:443"]=true' <<< "$combined" | jq --sort-keys --arg host nuc.ide-newton.ts.net --from-file "$component_dir/serve-owned.jq")"
[[ "$public" != "$expected" ]]
printf 'PASS: unrelated archive routes are ignored; owned route drift and public exposure remain rejected\n'
