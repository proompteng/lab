#!/usr/bin/env bash
# Sourced by the isolated control harness and its generated promotion command.

control_fingerprint() {
  fixture_docker exec -i "$1" psql -XqAt -U postgres -d ofz_control -v ON_ERROR_STOP=1 <<'SQL'
CREATE FUNCTION pg_temp.control_fingerprint() RETURNS text LANGUAGE plpgsql STABLE AS $fingerprint$
DECLARE
  relation record;
  rows jsonb;
  snapshot jsonb := '{}'::jsonb;
BEGIN
  FOR relation IN SELECT tablename FROM pg_tables WHERE schemaname='ofz' ORDER BY tablename LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), ''[]''::jsonb) FROM ofz.%I t', relation.tablename) INTO rows;
    snapshot := jsonb_set(snapshot, ARRAY[relation.tablename], rows);
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(snapshot)) < 19 THEN
    RAISE EXCEPTION 'incomplete authorization control fingerprint';
  END IF;
  RETURN encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
END;
$fingerprint$;
SELECT pg_temp.control_fingerprint();
SQL
}

prepare_database_failover() {
  local primary="$1" standby="$2" network="$3" primary_ip="$4" image="$5" directory="$6"
  shift 6
  local docker_args=("$@")
  local count failover_attempt
  count="$(fixture_docker exec "$primary" psql -XAt -U postgres -d ofz_control -c 'SELECT count(*) FROM ofz.commands WHERE receipt IS NOT NULL')"
  [[ "$count" -gt 0 ]]
  control_fingerprint "$primary" > "$directory/control.fingerprint"
  fixture_docker exec "$primary" bash -ec 'printf "hostssl replication postgres 0.0.0.0/0 trust\n" >> /tmp/ofz-data/pg_hba.conf; pg_ctl -D /tmp/ofz-data reload' >/dev/null
  # The base backup includes postgres/SpiceDB, ofz_control and tengri_control at one physical recovery point.
  # shellcheck disable=SC2016
  fixture_docker run --detach --name "$standby" --network "$network" \
    --tmpfs /tmp:rw,size=536870912,mode=1777 --memory 768m --entrypoint bash "$image" -ec \
    'for attempt in $(seq 1 300); do if test -f /tmp/fixture-ready; then break; fi; sleep 0.1; done; test -f /tmp/fixture-ready; pg_basebackup --checkpoint=fast -d "host=$1 port=5432 user=postgres sslmode=require application_name=ofz_fixture_standby" -D /tmp/ofz-standby -R -X stream >/dev/null; exec postgres -D /tmp/ofz-standby -c track_commit_timestamp=on -c listen_addresses="*" -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key' \
    -- "$primary" >/dev/null
  fixture_docker exec --user 0 -i "$standby" sh -ec 'cat > /tmp/server.crt' < "$directory/server.crt"
  fixture_docker exec --user 0 -i "$standby" sh -ec 'cat > /tmp/server.key' < "$directory/server.key"
  fixture_docker exec --user 0 "$standby" sh -ec 'chown postgres:postgres /tmp/server.key /tmp/server.crt; chmod 600 /tmp/server.key; touch /tmp/fixture-ready'
  for failover_attempt in $(seq 1 60); do
    if [[ "$(fixture_docker exec "$primary" psql -XAt -U postgres -c "SELECT count(*) FROM pg_stat_replication WHERE application_name='ofz_fixture_standby' AND state='streaming'")" == 1 ]]; then break; fi
    if [[ "$failover_attempt" == 60 ]]; then fixture_docker logs "$standby"; return 1; fi
    sleep .1
  done
  fixture_docker exec "$primary" psql -XAt -U postgres -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET synchronous_standby_names='FIRST 1 (ofz_fixture_standby)'" >/dev/null
  fixture_docker exec "$primary" psql -XAt -U postgres -v ON_ERROR_STOP=1 -c 'SELECT pg_reload_conf()' >/dev/null
  for failover_attempt in $(seq 1 60); do
    if [[ "$(fixture_docker exec "$primary" psql -XAt -U postgres -c "SELECT count(*) FROM pg_stat_replication WHERE application_name='ofz_fixture_standby' AND state='streaming' AND sync_state='sync'")" == 1 ]]; then break; fi
    if [[ "$failover_attempt" == 60 ]]; then fixture_docker logs "$primary"; return 1; fi
    sleep .1
  done
  [[ "$(fixture_docker exec "$standby" psql -XAt -U postgres -c 'SELECT pg_is_in_recovery()')" == t ]]
  [[ "$(fixture_docker exec "$primary" psql -XAt -U postgres -c 'SHOW synchronous_commit')" == on ]]
  export TENGRI_DATABASE_FAILOVER_COMMAND="$directory/promote.sh"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    declare -p docker_args
    # shellcheck disable=SC2016
    printf 'fixture_docker() { docker "${docker_args[@]}" "$@"; }\n'
    printf 'source %q\n' "$PWD/tests/database-failover.sh"
    printf 'promote_database %q %q %q %q %q\n' "$primary" "$standby" "$network" "$primary_ip" "$directory/control.fingerprint"
  } > "$TENGRI_DATABASE_FAILOVER_COMMAND"
  chmod 700 "$TENGRI_DATABASE_FAILOVER_COMMAND"
  printf 'Physical fixture: synchronous standby ready; %s committed command receipts captured\n' "$count"
}

promote_database_containers() {
  local primary="$1" standby="$2" network="$3" primary_ip="$4"
  fixture_docker exec -i "$primary" psql -XqAt -U postgres -d tengri_control -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
SET ROLE tengri_bff;
SELECT tengri.begin_oauth(decode(repeat('51',32),'hex'),decode(repeat('52',32),'hex'),repeat('v',43),repeat('n',43),gen_random_uuid());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM tengri.oauth_attempts WHERE state_hash=decode(repeat('51',32),'hex')) THEN
    RAISE EXCEPTION 'unfinished OAuth attempt missing before promotion';
  END IF;
END $$;
SQL
  fixture_docker kill --signal KILL "$primary" >/dev/null
  fixture_docker network disconnect --force "$network" "$primary"
  fixture_docker network disconnect "$network" "$standby"
  # Reuse the service address so existing clients reconnect without a new DSN or process.
  fixture_docker network connect --ip "$primary_ip" --alias "$primary" "$network" "$standby"
  fixture_docker exec "$standby" pg_ctl -D /tmp/ofz-standby promote --wait --timeout=5 >/dev/null
  [[ "$(fixture_docker exec "$standby" psql -XAt -U postgres -c 'SELECT pg_is_in_recovery()')" == f ]]
  [[ "$(fixture_docker exec "$standby" psql -XAt -U postgres -d tengri_control -c 'SELECT count(*) FROM tengri.oauth_attempts')" == 0 ]]
}

promote_database() {
  local primary="$1" standby="$2" network="$3" primary_ip="$4" fingerprint="$5"
  [[ "${TENGRI_DATABASE_FAILOVER_FIXTURE:-}" == 1 && "$primary" =~ ^ofz-control-[a-zA-Z0-9.-]+-db$ && "$standby" =~ ^ofz-control-[a-zA-Z0-9.-]+-standby$ && "$network" =~ ^ofz-control-[a-zA-Z0-9.-]+-net$ && "$primary_ip" =~ ^[0-9.]+$ ]]
  if [[ -n "${OFZ_FIXTURE_SSH:-}" ]]; then
    # One SSH transport keeps harness startup out of the five-second replay proof.
    {
      # shellcheck disable=SC2016
      printf 'set -euo pipefail\nfixture_docker() { docker "$@"; }\n'
      declare -f promote_database_containers
      # shellcheck disable=SC2016
      printf 'promote_database_containers "$@"\n'
    } | ssh -o BatchMode=yes "$OFZ_FIXTURE_SSH" bash -s -- "$primary" "$standby" "$network" "$primary_ip"
  else
    promote_database_containers "$primary" "$standby" "$network" "$primary_ip"
  fi
  control_fingerprint "$standby" > "$fingerprint.after"
  cmp "$fingerprint" "$fingerprint.after"
  printf 'Physical promotion: original primary killed; all Ofz control tables unchanged\n'
}
