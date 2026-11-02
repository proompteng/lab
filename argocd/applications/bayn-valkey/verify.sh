#!/bin/sh
set -eu

cli() {
  valkey-cli --no-auth-warning --raw --tls \
    --cacert /tls/ca.crt --cert /tls/tls.crt --key /tls/tls.key \
    --sni "$VALKEY_TLS_SERVER_NAME" --user "$VALKEY_USERNAME" \
    -h "$VALKEY_HOST" -p "$VALKEY_PORT" "$@"
}
replica() {
  VALKEY_HOST="$VALKEY_REPLICA_HOST" cli "$@"
}

ready=false
attempt=1
while [ "$attempt" -le 60 ]; do
  if [ "$(cli PING 2>/dev/null || true)" = PONG ] &&
     [ "$(replica PING 2>/dev/null || true)" = PONG ]; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 3
done
test "$ready" = true

key="bayn:acceptance:${TEST_RUN_ID:?}"
test "$(printf 'SET %s verified EX 600\nWAIT 1 3000\n' "$key" | cli)" = "$(printf 'OK\n1')"
test "$(cli GET "$key")" = verified
test "$(replica GET "$key")" = verified
test "$(cli DEL "$key")" = 1
echo 'PASS: TLS-authenticated primary writes, replica reads and deletion'

denied=$(cli GET forbidden:acceptance 2>&1) || true
printf '%s\n' "$denied" | grep -q NOPERM
echo 'PASS: application ACL rejects keys outside bayn:*'

unauthenticated=$(REDISCLI_AUTH='' cli GET 'bayn:acceptance:unauthenticated' 2>&1) || true
printf '%s\n' "$unauthenticated" | grep -Eq 'NOAUTH|WRONGPASS'
echo 'PASS: requests without the application password are rejected'
