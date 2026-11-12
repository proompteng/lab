#!/usr/bin/env bash
set -euo pipefail
export PGSSLMODE=verify-full PGTZ=UTC PGCONNECT_TIMEOUT=10
src() {
  PGHOST="$SOURCE_HOST" PGDATABASE="$SOURCE_DATABASE" PGUSER="$SOURCE_USER" PGPASSWORD="$SOURCE_PASSWORD" \
    PGSSLROOTCERT=/certs/source/ca.crt psql -X -v ON_ERROR_STOP=1 "$@"
}
dst() {
  PGHOST="$TARGET_HOST" PGDATABASE="$TARGET_DATABASE" PGUSER="$TARGET_USER" PGPASSWORD="$TARGET_PASSWORD" \
    PGSSLROOTCERT=/certs/target/ca.crt psql -X -v ON_ERROR_STOP=1 "$@"
}
fail() { echo "$1" >&2; exit 1; }
# Check query status before comparing output: [[ ]] and process substitution do
# not propagate a failed psql exit, including failures after partial stdout.
source_read_only=$(src -Atc 'SHOW default_transaction_read_only') || fail 'Source fence read failed'
[[ "$source_read_only" == on ]] || fail 'Source database must be fenced read-only first'
target_read_only=$(dst -Atc 'SHOW transaction_read_only') || fail 'Target writability read failed'
[[ "$target_read_only" == off ]] || fail 'Target must accept writes'
inventory=$(src -Atc 'SELECT capture_id FROM native_arrival_epochs ORDER BY capture_id') || fail 'Source capture inventory read failed'
[[ -n "$inventory" ]] || fail 'Source capture inventory is empty'
mapfile -t captures <<< "$inventory"
index=0
for capture in "${captures[@]}"; do
  [[ "$capture" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid capture identity'
  index=$((index + 1))
  epoch="SELECT encode(sha256(convert_to(content_hash || ':' || payload || ':' || recorded_at::text,'UTF8')),'hex') FROM native_arrival_epochs WHERE capture_id='$capture'"
  expected_epoch=$(src -Atc "$epoch") || fail 'Source capture metadata read failed'
  actual_epoch=$(dst -Atc "$epoch") || fail 'Target capture metadata read failed'
  if [[ -z "$actual_epoch" ]]; then
    src -c "COPY (SELECT capture_id,content_hash,payload,recorded_at FROM native_arrival_epochs WHERE capture_id='$capture') TO STDOUT (FORMAT binary)" |
      dst -c 'COPY native_arrival_epochs (capture_id,content_hash,payload,recorded_at) FROM STDIN (FORMAT binary)'
  else
    [[ "$actual_epoch" == "$expected_epoch" ]] || fail 'Existing capture metadata differs'
  fi
  last=$(dst -Atc "SELECT coalesce(max(ordinal),-1) FROM native_arrival_chunks WHERE capture_id='$capture'") || fail 'Target prefix ordinal read failed'
  source_last=$(src -Atc "SELECT coalesce(max(ordinal),-1) FROM native_arrival_chunks WHERE capture_id='$capture'") || fail 'Source prefix ordinal read failed'
  [[ "$last" =~ ^-?[0-9]+$ && "$source_last" =~ ^-?[0-9]+$ ]] || fail 'Invalid prefix ordinal'
  (( last <= source_last )) || fail 'Target capture extends beyond source'
  if (( last >= 0 )); then
    prefix="SELECT content_hash FROM native_arrival_chunks WHERE capture_id='$capture' AND ordinal=$last"
    expected_prefix=$(src -Atc "$prefix") || fail 'Source ordered prefix read failed'
    actual_prefix=$(dst -Atc "$prefix") || fail 'Target ordered prefix read failed'
    [[ "$expected_prefix" == "$actual_prefix" ]] || fail 'Existing ordered prefix differs'
  fi
  if (( last < source_last )); then
    src -c "COPY (SELECT capture_id,ordinal,content_hash,header,compressed FROM native_arrival_chunks WHERE capture_id='$capture' AND ordinal>$last ORDER BY ordinal) TO STDOUT (FORMAT binary)" |
      dst -c 'COPY native_arrival_chunks (capture_id,ordinal,content_hash,header,compressed) FROM STDIN (FORMAT binary)'
  fi
  manifest="SELECT count(*) || ':' || coalesce(max(ordinal),-1) || ':' || encode(sha256(convert_to(coalesce(string_agg(ordinal::text || ':' || content_hash,',' ORDER BY ordinal),''),'UTF8')),'hex') FROM native_arrival_chunks WHERE capture_id='$capture'"
  expected_manifest=$(src -Atc "$manifest") || fail 'Source capture manifest read failed'
  actual_manifest=$(dst -Atc "$manifest") || fail 'Target capture manifest read failed'
  [[ "$expected_manifest" == "$actual_manifest" ]] || fail 'Copied capture prefix differs'
  actual_epoch=$(dst -Atc "$epoch") || fail 'Copied capture metadata read failed'
  [[ "$actual_epoch" == "$expected_epoch" ]] || fail 'Copied capture metadata differs'
  ending="SELECT encode(sha256(convert_to(payload::text || ':' || recorded_at::text,'UTF8')),'hex') FROM native_arrival_ends WHERE capture_id='$capture'"
  expected_end=$(src -Atc "$ending") || fail 'Source capture ending read failed'
  actual_end=$(dst -Atc "$ending") || fail 'Target capture ending read failed'
  if [[ -n "$expected_end" && -z "$actual_end" ]]; then
    src -c "COPY (SELECT capture_id,payload,recorded_at FROM native_arrival_ends WHERE capture_id='$capture') TO STDOUT (FORMAT binary)" |
      dst -c 'COPY native_arrival_ends (capture_id,payload,recorded_at) FROM STDIN (FORMAT binary)'
  fi
  actual_end=$(dst -Atc "$ending") || fail 'Copied capture ending read failed'
  [[ "$actual_end" == "$expected_end" ]] || fail 'Copied capture ending differs'
  echo "Verified capture $index/${#captures[@]} through ordinal $source_last"
done
inventory_count=$(src -Atc 'SELECT count(*) FROM native_arrival_epochs') || fail 'Final source capture inventory read failed'
[[ "$inventory_count" == "${#captures[@]}" ]] || fail 'Source capture inventory changed'
echo 'All source epochs, compressed chunks, ordered prefixes and endings verified'
