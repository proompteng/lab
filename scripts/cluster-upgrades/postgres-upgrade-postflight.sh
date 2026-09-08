#!/usr/bin/env bash

set -eo pipefail

usage() {
  cat >&2 <<'EOF'
usage: postgres-upgrade-postflight.sh --namespace NAMESPACE --cluster CLUSTER \
  --expected-image IMAGE [--apply-extension-updates] [--context KUBE_CONTEXT]

Validate a completed CNPG PostgreSQL transition. The default mode is read-only.
--apply-extension-updates explicitly runs CNPG's generated update_extensions.sql
once with psql when pg_upgrade emitted it. The generated script contains the
database selection needed to update extensions across the cluster.
EOF
  exit 2
}

die() {
  echo "postgres-upgrade-postflight: $*" >&2
  exit 1
}

KUBECTL_BIN="$(printenv KUBECTL_BIN 2>/dev/null || printf kubectl)"
JQ_BIN="$(printenv JQ_BIN 2>/dev/null || printf jq)"
KUBE_CONTEXT="$(printenv KUBE_CONTEXT 2>/dev/null || printf galactic-lan)"
UPDATE_EXTENSIONS_PATH="$(printenv UPDATE_EXTENSIONS_PATH 2>/dev/null || printf /var/lib/postgresql/data/pgdata/update_extensions.sql)"
namespace=
cluster=
expected_image=
apply_updates=0

while (($# > 0)); do
  case "$1" in
    --namespace)
      (($# >= 2)) || usage
      namespace="$2"
      shift 2
      ;;
    --cluster)
      (($# >= 2)) || usage
      cluster="$2"
      shift 2
      ;;
    --expected-image)
      (($# >= 2)) || usage
      expected_image="$2"
      shift 2
      ;;
    --apply-extension-updates)
      apply_updates=1
      shift
      ;;
    --context)
      (($# >= 2)) || usage
      KUBE_CONTEXT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$namespace" =~ ^[A-Za-z0-9.-]+$ ]] || usage
[[ "$cluster" =~ ^[A-Za-z0-9.-]+$ ]] || usage
[[ -n "$expected_image" ]] || usage
[[ -n "$KUBE_CONTEXT" ]] || usage
[[ "$UPDATE_EXTENSIONS_PATH" == /* ]] || die "UPDATE_EXTENSIONS_PATH must be an absolute path"
command -v "$KUBECTL_BIN" >/dev/null 2>&1 || die "kubectl is required"
command -v "$JQ_BIN" >/dev/null 2>&1 || die "jq is required"

target_major=
target_minor=
case "$expected_image" in
  ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e)
    target_major=17; target_minor=11
    ;;
  ghcr.io/cloudnative-pg/postgresql:17.11-system-trixie@sha256:362b039f643f1c09a34edd63d9a78903e5f1f4f43c24236cc8459621eb676d12)
    target_major=17; target_minor=11
    ;;
  ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533)
    target_major=18; target_minor=6
    ;;
  ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1)
    target_major=18; target_minor=6
    ;;
  *)
    die "expected image is not a verified immutable PostgreSQL 17.11/18.6 reference: $expected_image"
    ;;
esac

cluster_json="$($KUBECTL_BIN --context "$KUBE_CONTEXT" --namespace "$namespace" get cluster "$cluster" -o json 2>/dev/null)" || \
  die "unable to read Cluster $namespace/$cluster"
api_version="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.apiVersion // empty')"
kind="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.kind // empty')"
[[ "$api_version" == "postgresql.cnpg.io/v1" && "$kind" == "Cluster" ]] || \
  die "$namespace/$cluster is not a postgresql.cnpg.io/v1 Cluster"

ready="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '[.status.conditions[]? | select(.type == "Ready") | .status][0] // "False"')"
[[ "$ready" == "True" ]] || die "Cluster is not Ready (condition=$ready)"
phase="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.phase // empty')"
phase_display="$phase"
[[ -n "$phase_display" ]] || phase_display='<empty>'
[[ "$phase" == "Cluster in healthy state" ]] || die "Cluster phase is not healthy: $phase_display"
instances="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.spec.instances // 0')"
ready_instances="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.readyInstances // 0')"
[[ "$instances" == "$ready_instances" && "$instances" -gt 0 ]] || die "only $ready_instances/$instances instances are ready"

observed_image="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.pgDataImageInfo.image // empty')"
[[ "$observed_image" == "$expected_image" ]] || die "status image is $observed_image, expected $expected_image"
observed_major="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.pgDataImageInfo.majorVersion // empty')"
[[ "$observed_major" == "$target_major" ]] || die "status major is $observed_major, expected $target_major"
primary="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.currentPrimary // empty')"
[[ -n "$primary" ]] || die "Cluster has no current primary"

run_psql() {
  local database="$1"
  local sql="$2"
  "$KUBECTL_BIN" --context "$KUBE_CONTEXT" cnpg psql "$cluster" --namespace "$namespace" -- -d "$database" -At -c "$sql" < /dev/null 2>/dev/null
}

if ! server_version_num="$(run_psql postgres "SELECT current_setting('server_version_num');")"; then
  die "unable to query PostgreSQL server_version_num"
fi
expected_version_num=$((target_major * 10000 + target_minor))
[[ "$server_version_num" == "$expected_version_num" ]] || \
  die "server_version_num=$server_version_num, expected $expected_version_num"
echo "Postflight version: PostgreSQL $target_major.$target_minor ($server_version_num), image is pinned and Ready."

if ! databases="$(run_psql postgres 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;')"; then
  die "unable to discover databases"
fi
[[ -n "$databases" ]] || die "Cluster reports no connectable databases"

for database in $databases; do
  [[ "$database" =~ ^[A-Za-z0-9_.$-]+$ ]] || die "refusing unsafe database name $database"
  if ! extensions="$(run_psql "$database" 'SELECT extname || chr(9) || extversion FROM pg_extension ORDER BY 1;')"; then
    die "unable to inspect extensions in database $database"
  fi
  database_size="$(run_psql "$database" 'SELECT pg_size_pretty(pg_database_size(current_database()));')"
  extension_display="$extensions"
  [[ -n "$extension_display" ]] || extension_display=none
  echo "Database $database: size=$database_size extensions=$extension_display"
  while IFS=$'\t' read -r extension_name extension_version; do
    [[ -n "$extension_name" ]] || continue
    case "$extension_name" in
      plpgsql|pgcrypto|pg_trgm|vector) ;;
      *) die "unsupported extension remains after upgrade: $extension_name" ;;
    esac
    [[ -n "$extension_version" ]] || die "extension $extension_name has no reported version"
  done <<< "$extensions"
done

update_pending=0
if "$KUBECTL_BIN" --context "$KUBE_CONTEXT" --namespace "$namespace" exec "$primary" -- test -s "$UPDATE_EXTENSIONS_PATH" >/dev/null 2>&1; then
  update_pending=1
fi

if ((update_pending == 1)); then
  if ((apply_updates == 0)); then
    die "pg_upgrade emitted $UPDATE_EXTENSIONS_PATH; rerun with --apply-extension-updates, then repeat this check"
  fi
  echo "Applying $UPDATE_EXTENSIONS_PATH once to $namespace/$cluster; generated script selects each database"
  "$KUBECTL_BIN" --context "$KUBE_CONTEXT" --namespace "$namespace" exec -i "$primary" -- \
    psql --set=ON_ERROR_STOP=1 --file "$UPDATE_EXTENSIONS_PATH" >/dev/null
  echo "Applied generated extension updates; repeat postflight after the operator settles."
else
  echo "No pg_upgrade update_extensions.sql is present."
fi

echo "Postflight passed (database connections and extension inventory verified)."
