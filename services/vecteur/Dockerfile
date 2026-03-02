ARG PG_MAJOR=18
ARG RELEASE=202509290807
ARG FLAVOR=minimal
ARG OS=trixie

FROM ghcr.io/cloudnative-pg/postgresql:${PG_MAJOR}.0-${RELEASE}-${FLAVOR}-${OS}

ARG PG_MAJOR

USER root

RUN set -euxo pipefail \
  && export DEBIAN_FRONTEND=noninteractive \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-${PG_MAJOR}-pgvector \
  && rm -rf /var/lib/apt/lists/*

RUN cat <<'EOF' > /usr/local/bin/docker-entrypoint.sh
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 0 ] && [ "$1" != "postgres" ]; then
  exec "$@"
fi

run_as_postgres() {
  su -s /bin/sh postgres -lc "$1"
}

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export PGPORT="${PGPORT:-5432}"
export POSTGRES_USER="${POSTGRES_USER:-postgres}"
export POSTGRES_DB="${POSTGRES_DB:-${POSTGRES_USER}}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  mkdir -p "${PGDATA}"
  chown -R postgres:postgres "${PGDATA}"

  initdb_args=(
    "--username=${POSTGRES_USER}"
    "--pgdata=${PGDATA}"
  )

  if [ -n "${POSTGRES_PASSWORD}" ]; then
    pg_password_file=$(mktemp)
    printf '%s\n' "${POSTGRES_PASSWORD}" > "${pg_password_file}"
    initdb_args+=("--pwfile=${pg_password_file}")
  else
    pg_password_file=""
  fi

  run_as_postgres "initdb ${initdb_args[*]}"
  [ -n "${pg_password_file}" ] && rm -f "${pg_password_file}"
fi

if [ "${POSTGRES_DB}" != "${POSTGRES_USER}" ]; then
  run_as_postgres "createdb --owner='${POSTGRES_USER}' --encoding=UTF8 --template=template0 --if-not-exists '${POSTGRES_DB}'"
fi

exec su -s /bin/sh postgres -lc "postgres -D '${PGDATA}' -p '${PGPORT}' -c listen_addresses='*'"
EOF

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER 26
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
