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

RUN cat <<'EOF2' > /usr/local/bin/docker-entrypoint.sh
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 0 ] && [ "$1" != "postgres" ]; then
  exec "$@"
fi

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export PGPORT="${PGPORT:-5432}"
export POSTGRES_USER="${POSTGRES_USER:-postgres}"
export POSTGRES_DB="${POSTGRES_DB:-${POSTGRES_USER}}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  mkdir -p "${PGDATA}"

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

  initdb "${initdb_args[@]}"

  [ -n "${pg_password_file}" ] && rm -f "${pg_password_file}"

  if [ -n "${POSTGRES_DB}" ]; then
    pg_ctl -D "${PGDATA}" -o "-p ${PGPORT} -c listen_addresses='*'" -w start
    createdb --username="${POSTGRES_USER}" --owner="${POSTGRES_USER}" --encoding=UTF8 --template=template0 --if-not-exists "${POSTGRES_DB}"
    pg_ctl -D "${PGDATA}" -m fast -w stop
  fi
fi

exec postgres -D "${PGDATA}" -p "${PGPORT}" -c listen_addresses='*'
EOF2

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER postgres
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
